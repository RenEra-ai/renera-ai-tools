import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeCommand } from '../lib/safe-command.mjs';

test('isSafeCommand allows narrow pytest and unittest invocations', () => {
  const allowed = [
    'pytest',
    'pytest -q tests/test_health.py',
    'python -m pytest tests',
    'python3 -m unittest tests.test_health',
    '/bin/sh -lc "pytest -q tests/test_health.py"',
  ];
  for (const cmd of allowed) assert.equal(isSafeCommand(cmd), true, cmd);
});

test('isSafeCommand denies non-test runners and shell metacharacters', () => {
  const denied = [
    'git status',
    'rg TODO',
    'tox -e py',
    'nox -s tests',
    'pytest tests; rm -rf build',
    'pytest tests | cat',
    'pytest $(pwd)',
    'pytest .{.,}/x',
  ];
  for (const cmd of denied) assert.equal(isSafeCommand(cmd), false, cmd);
});

test('isSafeCommand denies config overrides and write-oriented pytest options', () => {
  const denied = [
    'pytest --basetemp=/tmp/x',
    'pytest --junitxml=report.xml',
    'pytest --rootdir=.',
    'pytest --config-file=pytest.ini',
    'pytest --override-ini addopts=-q',
    'pytest -cpytest.ini',
    'pytest -o addopts=-q',
    'python -m pytest --report-log=out.json',
  ];
  for (const cmd of denied) assert.equal(isSafeCommand(cmd), false, cmd);
});

test('isSafeCommand denies path escapes and env prefixes', () => {
  const denied = [
    'pytest /tmp/tests',
    'pytest ~/tests',
    'pytest ../tests',
    'pytest --cov-report=html:/tmp/x',
    'pytest --x=a,/tmp/x',
    'pytest --root=..:x',
    'PYTHONPATH=/tmp python -m pytest',
    'python -c "print(1)"',
    '/tmp/sh -c "pytest"',
  ];
  for (const cmd of denied) assert.equal(isSafeCommand(cmd), false, cmd);
});
