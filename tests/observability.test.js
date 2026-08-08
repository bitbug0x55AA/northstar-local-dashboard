const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-observability-'));
process.env.NORTHSTAR_OBSERVABILITY_PATH = path.join(directory, 'events.json');
const { recordEvent, listEvents, acknowledgeEvent, summarize } = require('../server/observability-store');

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('observability sanitizes secrets, filters events, and persists acknowledgement', () => {
  const event = recordEvent({
    id: 'event-1', tab: 'security', level: 'critical', source: 'test', eventType: 'credential',
    message: 'Credential exposure\nwas blocked', details: { token: 'do-not-store', useful: 'kept' }
  });
  assert.equal(event.message, 'Credential exposure was blocked');
  assert.deepEqual(event.details, { token: '[redacted]', useful: 'kept' });
  assert.equal(recordEvent(event).id, 'event-1', 'duplicate IDs must be idempotent');

  const alerts = listEvents({ tab: 'alerts', status: 'open' });
  assert.equal(alerts.length, 1);
  assert.equal(summarize(alerts).openAlerts, 1);

  const updated = acknowledgeEvent('event-1', 'resolved');
  assert.equal(updated.status, 'resolved');
  assert.equal(listEvents({ tab: 'alerts', status: 'open' }).length, 0);
  assert.throws(() => acknowledgeEvent('event-1', 'invalid'), /Invalid observability status/);
});
