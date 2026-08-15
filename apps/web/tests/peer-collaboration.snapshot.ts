// Pending real-model evidence for the shipped peer command and tools. The
// scenario remains absent from keyless replay until record mode creates both
// correlated root-session fixtures and the browser golden in one run.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, recordFixtureSet,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/peer-collaboration', import.meta.url))
const MAIN_FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const PEER_FIXTURE = join(SNAPSHOT_DIR, 'session.1.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const PEER_ID = SessionId('peer-collaboration-target')
const MODE = webSnapshotMode()
const RECORDED = [MAIN_FIXTURE, PEER_FIXTURE, UI_EXPECTED].every(existsSync)

const PROMPT = [
  'Use list_peers once with group snapshot_team.',
  `Then use send_to_peer once for session ${PEER_ID} in group snapshot_team,`,
  'with message "Reply with exactly PEER_REPLY_OK and nothing else." and wait until idle.',
  'After the wait completes, reply with exactly PEER_FLOW_DONE and stop.',
].join(' ')

describe.skipIf(MODE !== 'record' && !RECORDED)('web snapshot: peer collaboration', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let mainId: SessionId
  let peerHandle: AgentHandle
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : {
      replayFixture: MAIN_FIXTURE,
      replayChildFixtures: [PEER_FIXTURE],
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const roots = scaffold.ctx.agents.roots()
    expect(roots).toHaveLength(1)
    mainId = roots[0]!.id

    const peerCwd = join(scaffold.workspaceCwd, 'peer-workspace')
    await mkdir(peerCwd, { recursive: true })
    peerHandle = await scaffold.ctx.agents.create({
      sessionId: PEER_ID,
      meta: { cwd: peerCwd },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await peerHandle?.dispose()
    await scaffold?.close()
  })

  it('records human formation and one delivery-correlated model exchange', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-snapshot-peer-collaboration'))
    const input = page.locator('textarea').first()
    await input.fill('/peer create snapshot_team')
    await input.press('Enter')
    await page.getByText("Created peer group 'snapshot_team'.", { exact: false }).waitFor({ timeout: 10_000 })

    await input.fill(`/peer add snapshot_team ${PEER_ID}`)
    await input.press('Enter')
    await page.getByText(`Added '${PEER_ID}' to peer group 'snapshot_team'.`, { exact: true })
      .waitFor({ timeout: 10_000 })

    await input.fill(PROMPT)
    await input.press('Enter')
    await page.getByText('PEER_FLOW_DONE', { exact: true }).waitFor({ timeout: 180_000 })
    await expect.poll(() => scaffold.ctx.agents.get(PEER_ID)?.session.events.some(event => (
      event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('PEER_REPLY_OK'))
    )), { timeout: 30_000 }).toBe(true)

    const snapshot = `${await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)}\n`
    if (MODE === 'record') {
      await mkdir(SNAPSHOT_DIR, { recursive: true })
      await recordFixtureSet(scaffold, [
        { sessionId: mainId, fixturePath: MAIN_FIXTURE, token: '{{sessionId}}' },
        { sessionId: PEER_ID, fixturePath: PEER_FIXTURE },
      ])
      await writeFile(UI_EXPECTED, snapshot)
    } else {
      await compareOrRefreshGolden(UI_EXPECTED, snapshot.trimEnd(), MODE)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 240_000)
})
