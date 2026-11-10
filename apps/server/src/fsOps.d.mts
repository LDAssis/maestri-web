export type FsOp =
  | { op: "mkdirp"; path: string; mode?: number }
  | { op: "write"; path: string; data: string; mode?: number; ifChanged?: boolean }
  | { op: "append"; path: string; data: string; mode?: number }
  | { op: "copy"; src: string; dest: string; mode?: number }
  | { op: "read"; path: string }
  | { op: "upsert"; path: string; block: string; start: string; end: string; mode?: number }
  | { op: "rm"; path: string; recursive?: boolean };
export type FsResult = boolean | string | null | { error: string };
export function runOp(op: FsOp): FsResult;
export function runOps(ops: FsOp[]): FsResult[];
