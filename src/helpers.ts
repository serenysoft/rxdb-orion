import { RxSchema } from 'rxdb';
import {
  OrionPullExecuteOptions,
  OrionPushExecuteOptions,
  Request,
  Transporter,
} from './types';
import { compact, get, isEmpty, isNil, omit, omitBy } from 'lodash';

export function buildUrl(parts: (number | string)[]): string {
  return compact(parts)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function extractReferences(schema: RxSchema): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = Object.entries(schema.jsonSchema.properties);

  for (const [key, value] of entries) {
    if (value.type === 'array' && value.ref) {
      result[key] = value.ref;
    }
  }

  return result;
}

export async function executeRequest(
  transporter: Transporter,
  request: Request
) {
  const url = buildUrl([request.url, request.key, request.action]);
  const data = omitBy(request.data, isNil);

  const response = await transporter({
    url: url,
    method: request.method,
    params: request.params,
    headers: {
      ...request.headers,
      'Accept': 'application/json',
    },
    data,
  });

  return request.wrap ? get(response, request.wrap) : response;
}

export async function executeFetch(request: Request) {
  let url = request.url;
  const params: any = {
    method: request.method,
    headers: request.headers,
  };

  if (request.params && !isEmpty(request.params)) {
    url = [url, new URLSearchParams(request.params as any)].join('?');
  }

  if (request.data && !isEmpty(request.data)) {
    const data = omitBy(request.data, isNil);
    params.body = JSON.stringify(data);
  }

  const response = await fetch(url, params);
  return await response.json();
}

export async function executePull({
  collection,
  url,
  batchSize,
  params,
  data,
  wrap,
  headers,
  transporter,
}: OrionPullExecuteOptions): Promise<any[]> {
  const request = {
    url,
    wrap,
    headers,
    data,
    method: 'POST',
    action: '/search',
    params: {
      ...params,
      limit: batchSize,
    },
  };

  const response = await executeRequest(transporter, request);

  if (collection && response.length) {
    const primaryPath = collection.schema.primaryPath;
    const references = extractReferences(collection.schema);

    for (const item of response) {
      for (const [key, value] of Object.entries(references)) {
        const rows = await executePull({
          url: `${url}/${item[primaryPath]}/${key}`,
          transporter,
          wrap,
          batchSize,
        });

        const schema = collection.database.collections[value].schema;
        item[key] = rows.map((row) => row[schema.primaryPath]);
      }
    }
  }

  return response;
}

export async function executePush({
  url,
  headers,
  rows,
  collection,
  deletedField,
  primaryPath,
  transporter,
}: OrionPushExecuteOptions): Promise<[]> {
  const references = Object.keys(extractReferences(collection.schema));

  for (const row of rows) {
    const request: Request = { url, headers };
    const newDocState = row.newDocumentState as any;
    const data = omit<any>(newDocState, [deletedField, ...references]);

    const isDeleted = newDocState[deletedField];
    const isNew = !row.assumedMasterState;

    if (isDeleted) {
      request.method = 'DELETE';
      request.key = data[primaryPath];
    } else if (isNew) {
      request.method = 'POST';
      request.data = data;
    } else {
      request.method = 'PUT';
      request.key = data[primaryPath];
      request.data = data;
    }

    await executeRequest(transporter, request);

    if (!isDeleted) {
      for (const ref of references) {
        const resources = newDocState[ref];
        if (resources?.length) {
          await executeRequest(transporter, {
            url: buildUrl([url, data[primaryPath], ref, '/sync']),
            method: 'PATCH',
            data: { resources },
            headers,
          });
        }
      }
    }
  }

  return [];
}
