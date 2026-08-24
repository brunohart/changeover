// Pull fenced ```json / ```jsonc payloads out of a Markdown document.
// jsonc blocks have // line comments stripped before parsing. Blocks that are
// deliberately partial (a bare fragment, an HTTP preamble, a table) are skipped
// by returning them as unparseable and letting the caller decide — a
// specification that could not print an illustrative fragment would be worse
// than one whose harness understands the difference.

import { readFileSync } from 'node:fs';

const FENCE = /```(json|jsonc|http)\n([\s\S]*?)```/g;

/** Remove // line comments outside string literals. */
function stripLineComments(text) {
  let out = '';
  let inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

/** Drop an HTTP request/response preamble preceding the JSON body. */
function stripHttpPreamble(text) {
  const brace = text.indexOf('{');
  if (brace <= 0) return text;
  const head = text.slice(0, brace);
  if (/^(HTTP\/|GET |POST |PUT |DELETE |PATCH )/m.test(head)) return text.slice(brace);
  return text;
}

/** Split an http transcript into labelled parts, each with a JSON body. */
function splitHttpParts(body) {
  const lines = body.split('\n');
  const parts = [];
  let label = null, buffer = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (label && text.startsWith('{')) parts.push({ label, text });
    buffer = [];
  };
  for (const line of lines) {
    if (/^(HTTP\/[0-9.]+ |GET |POST |PUT |DELETE |PATCH )/.test(line)) { flush(); label = line.trim(); continue; }
    if (/^[A-Za-z-]+:\s/.test(line) && !buffer.length) continue; // header line before any body
    buffer.push(line);
  }
  flush();
  return parts;
}

export function extractJsonBlocks(path) {
  const source = readFileSync(path, 'utf8');
  const blocks = [];
  let match, index = 0;
  while ((match = FENCE.exec(source)) !== null) {
    const [, lang, body] = match;
    const line = source.slice(0, match.index).split('\n').length;
    if (lang === 'http') {
      // An http fence may print a request and a response in one block. Split on
      // each preamble line and parse every JSON body it contains, so the most
      // load-bearing payloads in the document cannot escape validation by
      // sitting inside a transcript.
      for (const part of splitHttpParts(body)) {
        let value, parseError = null;
        try { value = JSON.parse(part.text); } catch (e) { parseError = e.message; }
        blocks.push({ index: index++, lang, line, text: part.text, value, parseError, http: part.label });
      }
      continue;
    }
    let text = lang === 'jsonc' ? stripLineComments(body) : body;
    text = stripHttpPreamble(text);
    let value, parseError = null;
    try { value = JSON.parse(text); } catch (e) { parseError = e.message; }
    blocks.push({ index: index++, lang, line, text, value, parseError });
  }
  return blocks;
}
