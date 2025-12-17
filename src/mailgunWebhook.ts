import type { Request } from 'express';
import Busboy from 'busboy';

export type ParsedFields = Record<string, string>;

export async function parseMailgunInboundForm(req: Request, limits: { maxFieldSizeBytes: number }): Promise<ParsedFields> {
  if (req.is('multipart/form-data')) {
    return parseMultipart(req, limits);
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: ParsedFields = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

function parseMultipart(req: Request, limits: { maxFieldSizeBytes: number }): Promise<ParsedFields> {
  return new Promise((resolve, reject) => {
    const fields: ParsedFields = {};

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fieldSize: limits.maxFieldSizeBytes,
        fields: 10_000,
        files: 100,
      },
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (_name, fileStream) => {
      // v1: ignore attachments, but always drain.
      fileStream.resume();
    });

    busboy.on('error', (err) => reject(err));
    busboy.on('finish', () => resolve(fields));

    req.pipe(busboy);
  });
}

