export interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
  audio?: {
    url: string;
  };
  highlight?: string[];
}

export interface Reconstruction {
  id: string;
  label: string;
}

export interface AppState {
  messages: ChatMessage[];
  currentReconstruction: string;
  reconstructions: Reconstruction[];
  isLoading: boolean;
  error: string | null;
  scoreHighlights: string[];
}