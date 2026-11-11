import type { Backup, Conversation } from '../shared/model';
import type { ConversationLink, Project, ProjectConversation, Projects } from '../shared/projects';
import type { Database } from './database';

function newProject(name: string, createdAt = Date.now()): Project {
  return { id: crypto.randomUUID(), name, createdAt };
}

export function legacyProjectRecord(conversation: Conversation, projectsByName: Map<string, Project>) {
  const name = (conversation.folder ?? '').trim();
  const pinned = conversation.pinned === true;
  if (!name && !pinned) return null;
  let project = projectsByName.get(name);
  let created: Project | undefined;
  if (name && !project) {
    project = created = newProject(name, conversation.capturedAt);
    projectsByName.set(name, project);
  }
  const { id, url, title, capturedAt } = conversation;
  const record: ProjectConversation = { id, url, title, pinned, projectId: project?.id ?? null, joinedAt: capturedAt };
  return { record, created };
}

export function withProjectMetadata(conversations: Conversation[], workspace: Projects): Conversation[] {
  const byId = new Map(workspace.conversations.map(record => [record.id, record]));
  const names = new Map(workspace.projects.map(project => [project.id, project.name]));
  return conversations.map(conversation => {
    const record = byId.get(conversation.id);
    return { ...conversation, pinned: record?.pinned ?? false, folder: names.get(record?.projectId ?? '') ?? '' };
  });
}

type Operation = Parameters<Database['batch']>[0][number];

// Called by the service worker's serialized message queue. Writes that change
// multiple records are committed in a single IndexedDB transaction.
export class ProjectStore {
  constructor(private db: Database) {}

  all(): Promise<Projects> { return this.db.projectData(); }

  async create(name: string): Promise<Project> {
    const projects = await this.db.all<Project>('projects');
    if (projects.some(project => project.name === name)) throw new Error('已有同名项目');
    const project = newProject(name);
    await this.db.batch([{ store: 'projects', put: project }]);
    return project;
  }

  async rename(id: string, name: string): Promise<Project> {
    const projects = await this.db.all<Project>('projects');
    const old = projects.find(project => project.id === id);
    if (!old) throw new Error('项目已被移除');
    if (projects.some(project => project.id !== id && project.name === name)) throw new Error('已有同名项目');
    const project = { ...old, name };
    await this.db.batch([{ store: 'projects', put: project }]);
    return project;
  }

  async remove(id: string): Promise<boolean> {
    const workspace = await this.all();
    if (!workspace.projects.some(project => project.id === id)) return false;
    const ops: Operation[] = workspace.conversations.filter(row => row.projectId === id)
      .map(row => ({ store: 'projectConversations', put: { ...row, projectId: null } }));
    await this.db.batch([{ store: 'projects', remove: id }, ...ops]);
    return true;
  }

  async requireProject(id: string | null): Promise<void> {
    if (id !== null && !(await this.db.get('projects', id))) throw new Error('项目已被移除');
  }

  async assign(link: ConversationLink, projectId: string | null, onlyUnassigned: boolean): Promise<ProjectConversation> {
    const old = await this.current(link.id);
    if (onlyUnassigned && old?.projectId) return old;
    await this.requireProject(projectId);
    const row = this.entry(link, old, projectId, old?.pinned ?? false);
    await this.db.batch([{ store: 'projectConversations', put: row }]);
    return row;
  }

  async pin(link: ConversationLink, pinned: boolean): Promise<ProjectConversation> {
    const old = await this.current(link.id);
    const row = this.entry(link, old, old?.projectId ?? null, pinned);
    await this.db.batch([{ store: 'projectConversations', put: row }]);
    return row;
  }

  private async current(id: string): Promise<ProjectConversation | undefined> {
    if (await this.db.get('sideDeletedConversations', id)) throw new Error('原站会话已被删除');
    return this.db.get('projectConversations', id);
  }

  private entry(link: ConversationLink, old: ProjectConversation | undefined, projectId: string | null, pinned: boolean): ProjectConversation {
    const { id, url, title } = link;
    return { id, url, title, projectId, pinned, joinedAt: old?.projectId === projectId ? old.joinedAt : Date.now() };
  }

  async observe(links: ConversationLink[]): Promise<boolean> {
    const observed = new Map(links.map(link => [link.id, link]));
    const stored = await this.db.all<ProjectConversation>('projectConversations');
    const ops: Operation[] = [];
    for (const old of stored) {
      const link = observed.get(old.id);
      if (link && (link.title !== old.title || link.url !== old.url))
        ops.push({ store: 'projectConversations', put: { ...old, ...link } });
    }
    await this.db.batch(ops);
    return ops.length > 0;
  }

  async editSnapshot(snapshot: Conversation, requestedProjectId?: string | null): Promise<void> {
    const deleted = await this.db.get('sideDeletedConversations', snapshot.id);
    const ops: Operation[] = [{ store: 'conversations', put: snapshot }];
    if (deleted) {
      if (requestedProjectId || snapshot.folder || snapshot.pinned) throw new Error('原站会话已被删除');
    } else {
      let projectId = requestedProjectId;
      if (projectId === undefined) {
        const name = snapshot.folder.trim();
        const projects = name ? await this.db.all<Project>('projects') : [];
        let project = projects.find(row => row.name === name);
        if (name && !project) {
          project = newProject(name);
          ops.push({ store: 'projects', put: project });
        }
        projectId = project?.id ?? null;
      } else {
        await this.requireProject(projectId);
      }
      const old = await this.db.get<ProjectConversation>('projectConversations', snapshot.id);
      ops.push({ store: 'projectConversations', put: this.entry(old ?? snapshot, old, projectId, snapshot.pinned) });
    }
    await this.db.batch(ops);
  }

  async importOperations(backup: Backup): Promise<Operation[]> {
    const workspace = await this.all();
    const byId = new Map(workspace.projects.map(project => [project.id, project]));
    const byName = new Map(workspace.projects.map(project => [project.name, project]));
    const existing = new Set(workspace.conversations.map(row => row.id));
    const deleted = await this.db.all<{ id: string }>('sideDeletedConversations');
    for (const record of deleted) existing.add(record.id);
    const ops: Operation[] = [];
    if (backup.version < 4) {
      for (const snapshot of backup.conversations) {
        if (existing.has(snapshot.id)) continue;
        const legacy = legacyProjectRecord(snapshot, byName);
        if (!legacy) continue;
        if (legacy.created) ops.push({ store: 'projects', put: legacy.created });
        ops.push({ store: 'projectConversations', put: legacy.record });
        existing.add(snapshot.id);
      }
      return ops;
    }
    const projectIds = new Map<string, string>();
    for (const incoming of backup.projects ?? []) {
      const local = byId.get(incoming.id) ?? byName.get(incoming.name);
      projectIds.set(incoming.id, local?.id ?? incoming.id);
      if (local) continue;
      byId.set(incoming.id, incoming);
      byName.set(incoming.name, incoming);
      ops.push({ store: 'projects', put: incoming });
    }
    for (const row of backup.projectConversations ?? []) {
      if (existing.has(row.id)) continue;
      ops.push({ store: 'projectConversations', put: { ...row, projectId: projectIds.get(row.projectId ?? '') ?? null } });
    }
    return ops;
  }
}
