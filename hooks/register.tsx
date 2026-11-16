// mattermost-hub's hooks module: the /mm command, the 2 s poll of the hub's
// status.json, the Mattermost Hub pane and the status line. The work itself
// is in panel.tsx.

import type { Register } from 'claude-code'

import { PANE_ID, PANE_TITLE, noteViewport, poll, renderPane } from './panel'

const POLL_MS = 2_000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mm',
      description: 'Open the Mattermost Hub pane: routers, workers and their sessions',
      immediate: true,
    })
    await poll($)
    $.clock.every(POLL_MS, () => void poll($))

    return next(e)
  })

  on('command.run', { command: 'mm' }, async $ => {
    void poll($)
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })

    return {
      text: opened.isPlaced
        ? 'Mattermost Hub pane opened.'
        : `Mattermost Hub pane is open but not drawn yet: ${opened.reason}`,
    }
  })

  // session.start carries no viewport, so whether a pane would dock is read
  // where a surface says it: a remote client's attach, and the band above the
  // prompt, which every surface draws. The next poll does the open.
  on('session.attach', ($, e, next) => {
    noteViewport(e.viewport)

    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    noteViewport(e.viewport)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) =>
    renderPane($, e),
  )
}
