import { AxiosInstance } from 'axios';
import { get, isNil, omitBy } from 'lodash';
import { Request, Transporter } from './types';
import { buildUrl } from './helpers';

export class AxiosTransporter<T = any> implements Transporter {
  constructor(private http: AxiosInstance) {}

  async execute(request: Request): Promise<T> {
    const url = buildUrl([request.path, request.key, request.action]);
    const data = omitBy(request.data, isNil);

    try {
      const response = await this.http.request({
        url: url,
        method: request.method,
        headers: request.headers,
        params: request.params,
        data,
      });

      return request.wrap ? get(response.data, request.wrap) : response.data;
    } catch (error: any) {
      console.log(error.message);
      throw error;
    }
  }
}
