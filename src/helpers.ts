import { RxSchema } from 'rxdb';
import { OrionPullExecuteOptions, OrionPushExecuteOptions } from './types';
import { compact, omit } from 'lodash';

export function buildUrl(parts: (number | string)[]): string {
  return compact(parts)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function extractReferences(schema: RxSchema): string[] {
  const result: string[] = [];
  const entries = Object.entries(schema.jsonSchema.properties);

  entries.forEach(([key, value]) => {
    if (value.type === 'array' && value.ref) {
      result.push(key);
    }
  });

  return result;
}

export async function executePull({
  schema,
  baseUrl,
  batchSize,
  wrap,
  transporter,
}: OrionPullExecuteOptions): Promise<any[]> {
  let data;
  let page = 0;
  const result = [];

  do {
    const request = {
      method: 'POST',
      action: '/search',
      wrap,
      params: {
        page: page + 1,
        limit: batchSize,
      },
      ...baseUrl,
    };

    data = await transporter.execute(request);

    if (schema) {
      const primaryPath = schema.primaryPath;
      const references = extractReferences(schema);

      for (const item of data) {
        for (const ref of references) {
          const path = `${baseUrl.path}/${item[primaryPath]}/${ref}`;
          item[ref] = await executePull({
            baseUrl: { path },
            transporter,
            wrap,
            batchSize,
          });
        }
      }
    }

    result.push(...data);
    page++;
  } while (data.length === batchSize);

  return result;
}

export async function executePush({
  baseUrl,
  rows,
  schema,
  deletedField,
  primaryPath,
  transporter,
}: OrionPushExecuteOptions): Promise<[]> {
  const request = omit<any>(baseUrl, ['params']);
  const references = extractReferences(schema);

  for (const row of rows) {
    const isNew = !row.assumedMasterState;
    const newDocState = row.newDocumentState as any;
    const document = omit<any>(newDocState, [deletedField, ...references]);

    if (document[deletedField]) {
      request.method = 'DELETE';
      request.key = document[primaryPath];
    } else if (isNew) {
      request.method = 'POST';
      request.data = document;
    } else {
      request.method = 'PUT';
      request.key = document[primaryPath];
      request.data = document;
    }

    const result = await transporter.execute(request);

    for (const ref of references) {
      const path = buildUrl([baseUrl.path, result[primaryPath], ref, '/sync']);

      await transporter.execute({
        path,
        method: 'PATCH',
        data: { 'resources': newDocState[ref] },
      });
    }
  }

  return [];
}
