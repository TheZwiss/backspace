// The WHATWG URL global. Every runtime that loads this package provides it
// (Node, browsers, the Electron renderer and main process), but the package
// compiles against the ES2022 lib alone, which does not declare it. This file
// declares only the part the package uses: the constructor, which throws on
// a value that is not a URL.
//
// Nothing imports this file, so it is part of this package's own build and
// not of the server's or the web client's program: they typecheck these
// sources against @types/node or the DOM lib, which declare the full URL.

declare const URL: {
  new (url: string): unknown;
};
