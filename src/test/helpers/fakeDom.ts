// A small stand-in for the browser document a board page runs in, for loading a page script under
// Vitest without a DOM library. It covers what `board-pages/shared/board.js` and the pages use:
// elements with properties, attributes, listeners and children, text nodes, `getElementById`,
// focus, a dialog's `showModal`/`close`, and the `message` events of the tab's channel. It has no
// HTML parser on purpose: a page that tried `innerHTML` would put text, not elements, on the page,
// and `elements()` would show it.

export class FakeNode {
  parent: FakeElement | null = null;
  get textContent(): string {
    return '';
  }
  remove(): void {
    if (!this.parent) return;
    const siblings = this.parent.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
}

export class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
}

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export class FakeElement extends FakeNode {
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  dataset: Record<string, string> = {};
  [prop: string]: unknown;

  constructor(readonly tagName: string, private readonly doc: FakeDocument) {
    super();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      child.remove();
      child.parent = this;
      this.childNodes.push(child);
    }
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...nodes);
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  override get textContent(): string {
    return this.childNodes.map(n => n.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren(new FakeText(value));
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.dispatch('close');
  }
  /** Sends an event to this element's listeners, as a click or key press would. */
  dispatch(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  /** Whether a node is this element or below it. */
  contains(node: unknown): boolean {
    return node === this || this.children.some(c => c === node || (c instanceof FakeElement && c.contains(node)));
  }
  /** Every element below this one, in document order. */
  elements(): FakeElement[] {
    return this.children.flatMap(c => [c, ...c.elements()]);
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  /** The text selection: open when `anchorNode` is set and it is not collapsed. */
  selection: { anchorNode: unknown; isCollapsed: boolean; rangeCount: number } = { anchorNode: null, isCollapsed: true, rangeCount: 0 };
  readonly body: FakeElement;
  private listeners = new Map<string, Array<(event: { type: string }) => void>>();
  constructor() {
    this.body = new FakeElement('body', this);
  }
  addEventListener(type: string, listener: (event: { type: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** Sends a document-level event, such as the `pointerdown` and `pointerup` around a mouse press. */
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
  getSelection(): { anchorNode: unknown; isCollapsed: boolean; rangeCount: number } {
    return this.selection;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toLowerCase(), this);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }
  getElementById(id: string): FakeElement | null {
    return [this.body, ...this.body.elements()].find(el => el.id === id) ?? null;
  }
}

export class FakeWindow {
  private listeners = new Map<string, Array<(event: { type: string; data?: unknown }) => void>>();
  addEventListener(type: string, listener: (event: { type: string; data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  post(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ type: 'message', data });
  }
  /** Sends a window event other than a message, such as `focus` when the tab is looked at again. */
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

export interface FakePage {
  document: FakeDocument;
  window: FakeWindow;
  root: FakeElement;
  /** Every message the page posted to the extension. */
  posted: Array<{ id: number; op: string; body: Record<string, unknown> }>;
}

/**
 * Puts a fake document, window and VS Code API on the global object for a page script, with a root
 * element as the board's tab writes it. `answer` stands for the tab: it gets each request and
 * returns its data, or throws `{ status, message }` for a refusal.
 */
export function installFakePage(
  root: { kind: string; session: string; title: string },
  answer: (op: string, body: Record<string, unknown>) => Promise<unknown>,
): FakePage {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const rootEl = document.createElement('div');
  rootEl.id = 'root';
  rootEl.dataset = { kind: root.kind, session: root.session, title: root.title };
  document.body.append(rootEl);
  const posted: FakePage['posted'] = [];
  const g = globalThis as Record<string, unknown>;
  g.document = document;
  g.window = window;
  g.Node = FakeNode;
  g.acquireVsCodeApi = () => ({
    setState: () => undefined,
    postMessage: (message: { id: number; op: string; body: Record<string, unknown> }) => {
      posted.push(JSON.parse(JSON.stringify(message)));
      void answer(message.op, message.body).then(
        data => window.post({ id: message.id, ok: true, data }),
        (err: { status?: number; message?: string }) => window.post({ id: message.id, ok: false, status: err.status ?? 500, error: err.message ?? 'failed' }),
      );
    },
  });
  return { document, window, root: rootEl, posted };
}

/** Removes the fake page from the global object. */
export function removeFakePage(): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of ['document', 'window', 'Node', 'acquireVsCodeApi']) delete g[name];
}

/** Lets pending requests and their answers run. */
export async function settle(rounds = 8): Promise<void> {
  for (let n = 0; n < rounds; n++) await new Promise(resolve => setTimeout(resolve, 0));
}
