export const PROJECTS_EPOCH_KEY = 'ds-margin:projectsEpoch';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export interface ConversationLink {
  id: string;
  url: string;
  title: string;
}

export interface ProjectConversation extends ConversationLink {
  projectId: string | null;
  pinned: boolean;
  joinedAt: number;
}

export interface Projects {
  projects: Project[];
  conversations: ProjectConversation[];
}

export interface ProjectWorkspaceData extends Projects {
  deletedIds: string[];
}
