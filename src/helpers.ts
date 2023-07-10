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

export async function executeRequest(transporter: Transporter, request: Request) {
  const url = buildUrl([request.url, request.key, request.action]);
  const data = omitBy(request.data, isNil);

  const response = await transporter({
    url: url,
    method: request.method,
    headers: request.headers,
    params: request.params,
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
  schema,
  url,
  batchSize,
  params,
  wrap,
  headers,
  transporter,
}: OrionPullExecuteOptions): Promise<any[]> {
  let data;
  let page = 0;
  const result = [];

  do {
    const request = {
      url,
      wrap,
      headers,
      method: 'POST',
      action: '/search',
      params: {
        ...params,
        page: page + 1,
        limit: batchSize,
      },
    };

    data = await executeRequest(transporter, request);

    if (schema && data.length) {
      const primaryPath = schema.primaryPath;
      const references = extractReferences(schema);

      for (const item of data) {
        for (const ref of references) {
          item[ref] = await executePull({
            url: `${url}/${item[primaryPath]}/${ref}`,
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
  url,
  headers,
  rows,
  schema,
  deletedField,
  primaryPath,
  transporter,
}: OrionPushExecuteOptions): Promise<[]> {
  const request: Request = { url, headers };
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

    const result = await executeRequest(transporter, request);

    for (const ref of references) {
      await executeRequest(transporter, {
        url: buildUrl([url, result[primaryPath], ref, '/sync']),
        method: 'PATCH',
        data: { 'resources': newDocState[ref] },
        headers,
      });
    }
  }

  return [];
}
