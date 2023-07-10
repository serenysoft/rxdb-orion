import {
  MaybePromise,
  ReplicationOptions,
  RxReplicationWriteToMasterRow,
  RxSchema,
  WithDeleted,
} from 'rxdb';

export type RequestHeaders = Record<string, string | number | boolean>;
export type RequestParams = Record<string, string | number | object | boolean>;

export type Route = {
  url?: string;
  method?: string;
  params?: RequestParams;
  headers?: RequestHeaders;
};

export type Request = Route & {
  data?: any;
  key?: string | number;
  wrap?: string;
  action?: string;
};

export type Transporter = (request: Request) => Promise<any>;

export interface Modifier<RxDocType> {
  pull?: (data: any) => MaybePromise<WithDeleted<RxDocType>>;
  push?: (data: WithDeleted<RxDocType>) => MaybePromise<any>;
}

export type OrionBaseOptions = {
  wrap?: string;
  batchSize?: number;
  transporter?: Transporter;
};

export type OrionBaseExecuteOptions = OrionBaseOptions & {
  url?: string;
  headers?: RequestHeaders;
  schema?: RxSchema<any>;
};

export type OrionPullExecuteOptions = OrionBaseExecuteOptions & {
  params?: RequestParams;
  data?: any;
};

export type OrionPushExecuteOptions = OrionBaseExecuteOptions & {
  rows: RxReplicationWriteToMasterRow<any>[];
  deletedField: string;
  primaryPath: string;
};

export type OrionReplicationOptions<RxDocType> = OrionBaseOptions &
  Omit<ReplicationOptions<RxDocType, any>, 'pull' | 'push' | 'replicationIdentifier'> & {
    url: string;
    headers?: RequestHeaders;
    params?: RequestParams;
    updatedParam?: string;
    modifier?: Modifier<RxDocType>;
  };
