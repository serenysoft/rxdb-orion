import { Manager, replicateOrion } from '../src';
import { initDatabase } from './database';

describe('Manager polling', () => {
  it('does not queue resyncs while a pull is blocked and resumes when idle', async () => {
    const database = await initDatabase();
    let releasePull!: () => void;
    let enteredPull!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePull = resolve; });
    const entered = new Promise<void>((resolve) => { enteredPull = resolve; });
    const state = replicateOrion({
      collection: database.collections.roles,
      url: '/roles',
      waitForLeadership: false,
      transporter: async () => {
        enteredPull();
        await blocked;
        return { data: [] };
      },
    });
    const manager = new Manager([state], 10);
    const resync = jest.spyOn(state, 'reSync');

    try {
      await manager.start();
      await entered;
      // Accelerate the polling interval to reproduce a prolonged blocked request.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(resync).not.toHaveBeenCalled();
      releasePull();
      await manager.awaitInSync();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(resync).toHaveBeenCalled();
    } finally {
      releasePull();
      await manager.cancel();
      await database.close();
    }
  });
});
