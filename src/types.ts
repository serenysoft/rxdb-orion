import {
  MaybePromise,
  ReplicationOptions,
  RxReplicationWriteToMasterRow,
  RxSchema,
  WithDeleted,
} from 'rxdb';

export type RequestHeaders = Record<string, string | number | boolean>;
export type RequestParams = Record<string, string | number | object | boolean>;

export interface Route {
  path?: string;
  method?: string;
  params?: RequestParams;
  headers?: RequestHeaders;
}

export interface Request extends Route {
  data?: any;
  key?: string | number;
  wrap?: string;
  action?: string;
}

export interface Transporter<R = any> {
  execute(request: Request): Promise<R>;
}

export interface Modifier<RxDocType> {
  pull?: (data: any) => MaybePromise<WithDeleted<RxDocType>>;
  push?: (data: WithDeleted<RxDocType>) => MaybePromise<any>;
}

export type OrionBaseOptions = {
  wrap?: string;
  batchSize?: number;
  transporter: Transporter;
};

export type OrionBaseExecuteOptions = OrionBaseOptions & {
  baseUrl: Route;
  schema?: RxSchema<any>;
};

export type OrionPullExecuteOptions = OrionBaseExecuteOptions & {
  data?: any;
};

export type OrionPushExecuteOptions = OrionBaseExecuteOptions & {
  rows: RxReplicationWriteToMasterRow<any>[];
  deletedField: string;
  primaryPath: string;
};

export type OrionReplicationOptions<RxDocType> = OrionBaseOptions &
  Omit<ReplicationOptions<RxDocType, any>, 'pull' | 'push' | 'replicationIdentifier'> & {
    url: string | Route;
    updatedField?: string;
    updatedParam?: string;
    modifier?: Modifier<RxDocType>;
  };
