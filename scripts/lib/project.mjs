// PROJECTION_0_1 projector — HARNESS ONLY.
//
// This file may never be imported by a CHANGEOVER implementation, now or ever.
// C-ETAG asserts that TWO INDEPENDENT implementations produce byte-identical
// JCS bytes for a pinned golden fixture. If the reference implementation and
// the harness share a projector, that class proves only that a program agrees
// with itself. This projector exists so the claim is a fact rather than an
// assertion. Roughly thirty lines, written against the pointer list, not
// against any implementation.

/** Split an RFC 6901 pointer into decoded tokens. */
function tokens(pointer) {
  if (pointer === '') return [];
  if (pointer[0] !== '/') throw new Error(`not a JSON Pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Set value at token path inside target, creating containers as needed. */
function place(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextIsArrayEach = path[i + 1] === '-';
    if (nextIsArrayEach) { node[key] ??= []; node = node[key]; i++; continue; }
    node[key] ??= {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

/** Read value at token path from source. Returns undefined if any hop is absent. */
function read(source, path) {
  let node = source;
  for (const key of path) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Project an Occasion onto the closed pointer list.
 * `-` denotes every element of the array at that position, in document order.
 * Absent optional members are absent from the projection — never null.
 */
export function project(occasion, pointers) {
  const out = {};
  for (const pointer of pointers) {
    const path = tokens(pointer);
    const each = path.indexOf('-');
    if (each === -1) {
      const value = read(occasion, path);
      if (value !== undefined) place(out, path, value);
      continue;
    }
    const arrayPath = path.slice(0, each);
    const tailPath = path.slice(each + 1);
    const source = read(occasion, arrayPath);
    if (!Array.isArray(source)) continue;
    let target = out;
    for (const key of arrayPath.slice(0, -1)) { target[key] ??= {}; target = target[key]; }
    const arrayKey = arrayPath[arrayPath.length - 1];
    target[arrayKey] ??= [];
    source.forEach((element, index) => {
      const value = read(element, tailPath);
      if (value === undefined) return;
      target[arrayKey][index] ??= {};
      place(target[arrayKey][index], tailPath, value);
    });
    target[arrayKey] = target[arrayKey].filter(e => e !== undefined);
  }
  return out;
}

export { tokens };
