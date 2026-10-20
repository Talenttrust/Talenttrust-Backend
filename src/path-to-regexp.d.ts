// Minimal typings for path-to-regexp v0.1.x, the version bundled with Express 4.
// The package ships no declarations of its own.
declare module 'path-to-regexp' {
  interface Key {
    name: string | number;
    prefix: string;
    delimiter: string;
    optional: boolean;
    repeat: boolean;
    pattern: string;
  }

  interface Options {
    sensitive?: boolean;
    strict?: boolean;
    end?: boolean;
    start?: boolean;
    delimiter?: string;
    endsWith?: string;
    whitelist?: string;
  }

  function pathToRegexp(
    path: string | RegExp | Array<string | RegExp>,
    keys?: Key[],
    options?: Options,
  ): RegExp;

  export = pathToRegexp;
}
