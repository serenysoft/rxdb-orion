import { RxReplicationState, replicateRxCollection } from 'rxdb/plugins/replication';
import { RxCollection, RxReplicationPullStreamItem, RxReplicationWriteToMasterRow } from 'rxdb';
import { Modifier, OrionOptions, Request, Route, Transporter } from './types';
import { last, omit } from 'lodash';
import { Subject } from 'rxjs';

export const ORION_REPLICATION_PREFIX = 'orion-';

export * from './transporter';

export class OrionReplicateState<RxDocType> extends RxReplicationState<RxDocType, any> {
  constructor(
    public readonly replicationIdentifierHash: string,
    public readonly url: string | Route,
    public readonly collection: RxCollection<RxDocType>,
    public readonly transporter: Transporter,
    public readonly deletedField: string,
    public readonly updatedField: string,
    public readonly updatedParam: string,
    public readonly wrap: string,
    public readonly batchSize: number,
    public readonly modifier?: Modifier<RxDocType>,
    public readonly live?: boolean,
    public retryTime?: number,
    public autoStart?: boolean
  ) {
    super(
      replicationIdentifierHash,
      collection,
      deletedField,
      {
        batchSize,
        modifier: modifier?.pull,
        handler: (lastPulledCheckpoint: any, batchSize: number) => {
          return this.handlePull(lastPulledCheckpoint, batchSize);
        },
      },
      {
        batchSize,
        modifier: modifier?.pull,
        handler: (rows: RxReplicationWriteToMasterRow<RxDocType>[]) => {
          return this.handlePush(rows);
        },
      },
      live,
      retryTime,
      autoStart
    );
  }

  protected get baseUrl(): Route {
    return typeof this.url === 'string' ? { path: this.url } : this.url;
  }

  protected async handlePull(lastPulledCheckpoint: any, batchSize: number) {
    const updated = lastPulledCheckpoint?.[this.updatedField];
    const primaryPath = this.collection.schema.primaryPath;

    let data;
    let page = 0;
    const result = [];

    do {
      const scopes = updated ? [{ name: this.updatedParam, parameters: [updated] }] : null;

      const request = {
        method: 'POST',
        action: '/search',
        wrap: this.wrap,
        data: {
          scopes,
        },
        params: {
          page: page + 1,
          limit: batchSize,
        },
        ...this.baseUrl,
      };

      data = await this.transporter.execute(request);
      result.push(...data);

      page++;
    } while (data.length === batchSize);

    const lastDoc = last(result);
    const checkpoint = lastDoc
      ? {
          [primaryPath]: lastDoc[primaryPath],
          [this.updatedField]: lastDoc[this.updatedField],
        }
      : lastPulledCheckpoint;

    setTimeout(() => this.reSync(), this.retryTime);

    return {
      documents: result,
      checkpoint: checkpoint,
    };
  }

  protected async handlePush(rows: RxReplicationWriteToMasterRow<RxDocType>[]): Promise<[]> {
    const primaryPath = this.collection.schema.primaryPath;
    const request = omit<Request>(this.baseUrl, ['params']);

    for (const row of rows) {
      const isNew = !row.assumedMasterState;
      const document = row.newDocumentState as any;

      if (document[this.deletedField]) {
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

      await this.transporter.execute(request);
    }

    return [];
  }
}

export function replicateOrion<RxDocType>({
  url,
  collection,
  transporter,
  modifier,
  batchSize,
  waitForLeadership,
  deletedField = '_deleted',
  updatedField = 'updated_at',
  updatedParam = 'minUpdatedAt',
  wrap = 'data',
  live = true,
  retryTime = 1000 * 5, // in ms
  autoStart = false,
}: OrionOptions<RxDocType>): RxReplicationState<RxDocType, any> {
  const primaryPath = collection.schema.primaryPath;
  const baseUrl = typeof url === 'string' ? { path: url } : url;
  const pullStream$ = new Subject<RxReplicationPullStreamItem<RxDocType, any>>();

  const replicationPrimitivesPull = {
    batchSize,
    stream$: pullStream$.asObservable(),
    modifier: modifier?.pull,
    handler: async (lastPulledCheckpoint: any, batchSize: number) => {
      const updated = lastPulledCheckpoint?.[updatedField];

      let data;
      let page = 0;
      const result = [];

      do {
        const scopes = updated ? [{ name: updatedParam, parameters: [updated] }] : null;

        const request = {
          method: 'POST',
          action: '/search',
          wrap,
          data: {
            scopes,
          },
          params: {
            page: page + 1,
            limit: batchSize,
          },
          ...baseUrl,
        };

        data = await transporter.execute(request);
        result.push(...data);

        page++;
      } while (data.length === batchSize);

      const lastDoc = last(result);
      const checkpoint = lastDoc
        ? {
            [primaryPath]: lastDoc[primaryPath],
            [updatedField]: lastDoc[updatedField],
          }
        : lastPulledCheckpoint;

      return {
        documents: result,
        checkpoint: checkpoint,
      };
    },
  };

  const replicationPrimitivesPush = {
    batchSize,
    modifier: modifier?.push,
    handler: async (rows: RxReplicationWriteToMasterRow<RxDocType>[]): Promise<[]> => {
      const request = omit<Request>(baseUrl, ['params']);

      for (const row of rows) {
        const isNew = !row.assumedMasterState;
        const document = row.newDocumentState as any;

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

        await transporter.execute(request);
      }

      return [];
    },
  };

  return replicateRxCollection({
    replicationIdentifier: ORION_REPLICATION_PREFIX + collection.name,
    pull: replicationPrimitivesPull,
    push: replicationPrimitivesPush,
    collection,
    deletedField,
    live,
    retryTime,
    waitForLeadership,
    autoStart,
  });
}
