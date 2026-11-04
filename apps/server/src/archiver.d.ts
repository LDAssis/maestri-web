declare module "archiver" {
  import { Readable } from "node:stream";
  export class ZipArchive extends Readable {
    constructor(options?: { zlib?: { level?: number } });
    file(path: string, data: { name: string }): this;
    finalize(): Promise<void>;
  }
}
