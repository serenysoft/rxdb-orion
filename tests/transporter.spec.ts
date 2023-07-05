import { AxiosTransporter } from '../src/transporter';
import axios, { AxiosInstance } from 'axios';
import './transporter.mock';

describe('Axios transporter', () => {
  let http: AxiosInstance;
  let transporter: AxiosTransporter;

  beforeEach(() => {
    http = axios.create({ baseURL: 'http://api.fake.test' });
    transporter = new AxiosTransporter(http);
  });

  it('should execute request', async () => {
    const response = await transporter.execute({
      path: '/contacts',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    expect(Array.isArray(response)).toBe(true);
  });

  it('should execute request with wrap', async () => {
    const response = await transporter.execute({
      path: '/contacts/wrap',
      method: 'POST',
      wrap: 'data',
      data: { name: 'Jeff' },
    });

    expect(response).not.toHaveProperty('data');
    expect(response).toHaveProperty('name');
  });

  it('should omit nil values from request data', async () => {
    const data: any = {
      id: 'abcdef',
      name: 'jeff',
      last_name: null,
    };

    const request = jest
      .spyOn(http, 'request')
      .mockReturnValue(Promise.resolve({}));

    await transporter.execute({
      path: '/users',
      method: 'POST',
      data: data,
    });

    expect(request).toHaveBeenCalledWith({
      data: {
        id: 'abcdef',
        name: 'jeff',
      },
      method: 'POST',
      url: 'users',
      headers: undefined,
      params: undefined,
    });
  });
});
