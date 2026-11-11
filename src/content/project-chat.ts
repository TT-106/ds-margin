import type { MessageNode, SiteAdapter } from './adapter';

const startTimeout = 60_000;
const textForMatch = (text: string) => text.replace(/\r\n/g, '\n').trim();
const onNewChatPage = () => /^\/(?:a\/chat\/?|chat\/?)?$/.test(location.pathname);

/** A creation intent belongs to one native composer in one document. */
export class ProjectChat {
  private intent?: {
    projectId: string;
    initialId: string | null;
    blank: boolean;
    send?: { text: string; oldIds: Set<string>; id?: string };
  };
  private timer = 0;

  constructor(private adapter: SiteAdapter, private expired: () => void) {}

  get projectId() { return this.intent?.projectId ?? null; }

  arm(projectId: string) {
    this.cancel();
    this.intent = { projectId, initialId: this.adapter.id(), blank: onNewChatPage() };
    this.timer = window.setTimeout(() => {
      if (!this.intent?.blank) { this.cancel(); this.expired(); }
    }, startTimeout);
  }

  cancel() {
    this.intent = undefined;
    clearTimeout(this.timer);
  }

  routeChanged() {
    const intent = this.intent;
    if (!intent) return;
    if (onNewChatPage() && !intent.send?.id) {
      intent.blank = true;
      return;
    }
    const id = this.adapter.id();
    if (!intent.blank && id && id === intent.initialId) return;
    if (id && id !== intent.initialId && intent.blank && intent.send && !intent.send.oldIds.has(id) && (!intent.send.id || intent.send.id === id)) {
      intent.send.id = id;
      return;
    }
    this.cancel();
  }

  recordSend(text: string) {
    const intent = this.intent;
    if (!intent?.blank || !onNewChatPage()) return;
    const normalized = textForMatch(text);
    if (!normalized) return;
    intent.send = { text: normalized, oldIds: new Set(this.adapter.sidebarLayout.rows.map(row => row.link.id)) };
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.cancel(); this.expired(); }, startTimeout);
  }

  confirm(nodes: MessageNode[], composer: HTMLElement | null) {
    const intent = this.intent;
    const send = intent?.send;
    if (!intent || !send?.id || send.id !== this.adapter.id() || this.adapter.getText(composer).trim()) return;
    const userIndex = nodes.findIndex(({ message }) => message.role === 'user');
    if (userIndex < 0 || textForMatch(nodes[userIndex].message.text) !== send.text) return;
    // The stable reply confirms that this was accepted, even if the site
    // rendered the user message optimistically before getting a response.
    const reply = nodes[userIndex + 1]?.message;
    if (reply?.role !== 'assistant') return;
    const link = this.adapter.currentLink(nodes);
    if (!link || link.id !== send.id) return;
    this.cancel();
    return { ...link, projectId: intent.projectId, onlyUnassigned: true };
  }
}
