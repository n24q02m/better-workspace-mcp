/**
 * Single source of truth for N+2 domain tools. Each DomainDef fully
 * describes one domain (docs; Task 7b appends 9 more) -- registry.ts derives
 * TOOLS, RESOURCES, the help topic allowlist, and the CallTool dispatch map
 * from this one list instead of maintaining them as separate hand-synced
 * arrays. Adding a domain = pushing one DomainDef here.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CALENDAR_ACTIONS, calendar } from './calendar.js'
import { CHAT_ACTIONS, chat } from './chat.js'
import { DOCS_ACTIONS, docs } from './docs.js'
import { DRIVE_ACTIONS, drive } from './drive.js'
import type { DomainRunInput } from './factory.js'
import { GMAIL_ACTIONS, gmail } from './gmail.js'
import { PEOPLE_ACTIONS, people } from './people.js'
import { SHEETS_ACTIONS, sheets } from './sheets.js'
import { SLIDES_ACTIONS, slides } from './slides.js'
import { TASKS_ACTIONS, tasks } from './tasks.js'
import { TIME_ACTIONS, time } from './time.js'

export interface DomainDef {
  name: string // tool name, e.g. 'docs'
  description: string // tool description (actions summary)
  actions: readonly string[] // = the vendored service method names
  inputProps: Record<string, unknown> // JSON-schema properties beyond action+account
  run: (input: DomainRunInput) => Promise<CallToolResult>
}

export const DOMAINS: DomainDef[] = [
  {
    name: 'docs',
    description:
      'Google Docs operations.\n\nActions (required params -> optional):\n- getText (documentId -> tabId)\n- create (title -> content)\n- writeText (documentId, text -> position, tabId)\n- getSuggestions (documentId)\n- replaceText (documentId, findText, replaceText -> tabId)\n- formatText (documentId, formats -> tabId)\n\naccount is accepted but IGNORED in M1 (single-account; M2 wires per-account auth).',
    actions: DOCS_ACTIONS,
    inputProps: {
      documentId: { type: 'string', description: 'Google Doc ID or URL' },
      title: { type: 'string', description: 'Document title (for create)' },
      content: { type: 'string', description: 'Initial document content (for create)' },
      text: { type: 'string', description: 'Text to insert (for writeText)' },
      position: {
        type: 'string',
        description: 'Insert position for writeText: "beginning", "end" (default), or a positive integer index'
      },
      tabId: { type: 'string', description: 'Tab ID to target (optional, for multi-tab documents)' },
      findText: { type: 'string', description: 'Text to find (for replaceText)' },
      replaceText: { type: 'string', description: 'Replacement text (for replaceText)' },
      formats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            startIndex: { type: 'number' },
            endIndex: { type: 'number' },
            style: { type: 'string' },
            url: { type: 'string' }
          },
          required: ['startIndex', 'endIndex', 'style']
        },
        description: 'Formatting operations to apply (for formatText)'
      }
    },
    run: docs
  },
  {
    name: 'time',
    description:
      'Local date/time/timezone helpers (no Google account needed).\n\nActions:\n- getCurrentDate\n- getCurrentTime\n- getTimeZone',
    actions: TIME_ACTIONS,
    inputProps: {},
    run: time
  },
  {
    name: 'drive',
    description: 'Drive operations. Actions: ' + DRIVE_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: DRIVE_ACTIONS,
    inputProps: {
      fileId: { type: 'string' },
      folderId: { type: 'string' },
      folderName: { type: 'string' },
      query: { type: 'string' },
      name: { type: 'string' },
      newName: { type: 'string' },
      parentId: { type: 'string' },
      destinationFolderId: { type: 'string' }
    },
    run: drive
  },
  {
    name: 'calendar',
    description: 'Calendar operations. Actions: ' + CALENDAR_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: CALENDAR_ACTIONS,
    inputProps: {
      calendarId: { type: 'string' },
      eventId: { type: 'string' },
      summary: { type: 'string' },
      description: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      attendees: { type: 'array' }
    },
    run: calendar
  },
  {
    name: 'chat',
    description: 'Chat operations. Actions: ' + CHAT_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: CHAT_ACTIONS,
    inputProps: {
      spaceId: { type: 'string' },
      displayName: { type: 'string' },
      email: { type: 'string' },
      text: { type: 'string' },
      threadId: { type: 'string' }
    },
    run: chat
  },
  {
    name: 'gmail',
    description: 'Gmail operations. Actions: ' + GMAIL_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: GMAIL_ACTIONS,
    inputProps: {
      query: { type: 'string' },
      messageId: { type: 'string' },
      threadId: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      draftId: { type: 'string' },
      labelIds: { type: 'array' }
    },
    run: gmail
  },
  {
    name: 'slides',
    description: 'Slides operations. Actions: ' + SLIDES_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: SLIDES_ACTIONS,
    inputProps: {
      presentationId: { type: 'string' },
      title: { type: 'string' },
      slideId: { type: 'string' },
      text: { type: 'string' }
    },
    run: slides
  },
  {
    name: 'sheets',
    description: 'Sheets operations. Actions: ' + SHEETS_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: SHEETS_ACTIONS,
    inputProps: {
      spreadsheetId: { type: 'string' },
      range: { type: 'string' }
    },
    run: sheets
  },
  {
    name: 'tasks',
    description: 'Tasks operations. Actions: ' + TASKS_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: TASKS_ACTIONS,
    inputProps: {
      taskListId: { type: 'string' },
      taskId: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
      due: { type: 'string' }
    },
    run: tasks
  },
  {
    name: 'people',
    description: 'People operations. Actions: ' + PEOPLE_ACTIONS.join(', ') + '. account accepted (M1 ignored).',
    actions: PEOPLE_ACTIONS,
    inputProps: {
      resourceName: { type: 'string' }
    },
    run: people
  }
]
