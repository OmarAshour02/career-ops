import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFormPreview } from '../../autoapply/application-context.mjs';

const url = 'https://job-boards.greenhouse.io/example/jobs/123';
test('question preview makes only a public GET and preserves conditional and alternative fields', async () => {
  const body = { id: 123, questions: [{ label: 'Resume', required: true, fields: [{ name: 'resume', type: 'input_file' }, { name: 'resume_text', type: 'textarea' }] }], location_questions: [{ label: 'Latitude', required: true, fields: [{ type: 'input_hidden' }] }], demographic_questions: { questions: [{ label: 'Optional identity question', required: false }] } };
  const preview = await fetchFormPreview(url, { fetchImpl: async (api, options) => {
    assert.equal(api, 'https://boards-api.greenhouse.io/v1/boards/example/jobs/123?questions=true');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify(body));
  } });
  assert.equal(preview.advisory_only, true);
  assert.equal(preview.questions.length, 3);
  assert.equal(preview.questions[0].fields.length, 2);
  assert.equal(preview.questions[1].fields[0].type, 'input_hidden');
  assert.equal(preview.decision, undefined);
});
test('missing, closed, malformed and wrong-job previews stay inconclusive', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('not json'), new Response('{"id":456,"questions":[]}'), new Response('{"id":123}')]) {
    assert.deepEqual(await fetchFormPreview(url, { fetchImpl: async () => response }), { status: 'unavailable' });
  }
  assert.deepEqual(await fetchFormPreview(url, { fetchImpl: async () => { throw new Error('timeout'); } }), { status: 'unavailable' });
});
test('unknown and deceptive hosts never get fetched', async () => {
  for (const candidate of ['https://jobs.example/1', 'https://job-boards.greenhouse.io.evil.test/example/jobs/123', 'http://127.0.0.1/example/jobs/123']) {
    assert.deepEqual(await fetchFormPreview(candidate, { fetchImpl: () => { throw new Error('must not fetch'); } }), { status: 'unsupported' });
  }
});
