import nock from 'nock';

nock('http://api.fake.push')
  .post('/users/search')
  .query({ page: 1, limit: 3 })
  .reply(200, { data: [] })
  .post('/users')
  .reply(200, { id: '1', name: 'Jeff' })
  .patch('/users/1/roles/sync')
  .reply(200, {
    data: [
      {
        attached: ['100', '200'],
        detached: [],
        updated: [],
      },
    ],
  });

nock('http://api.fake.pull')
  .post('/users/search')
  .query({ page: 1, limit: 3, include: 'roles' })
  .reply(200, {
    data: [
      { id: '10', name: 'Jeff' },
      { id: '11', name: 'Mark' },
    ],
  })
  .post('/users/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [
      { id: '10', name: 'Jeff' },
      { id: '11', name: 'Mark' },
    ],
  })
  .post('/users/10/roles/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [{ id: '100', name: 'Admin' }],
  })
  .post('/users/11/roles/search')
  .query({ page: 1, limit: 3 })
  .reply(200, {
    data: [{ id: '200', name: 'Editor' }],
  });
