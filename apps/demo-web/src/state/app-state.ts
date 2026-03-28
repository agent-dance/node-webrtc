export interface Scenario1State {
  files: FileTransferStatus[];
  totalFiles: number;
  completedFiles: number;
  startTime: number | null;
  endTime: number | null;
}

export interface FileTransferStatus {
  id: string;
  name: string;
  size: number;
  bytesSent: number;
  sha256: string;
  verified: boolean | null;
}

export interface Scenario2State {
  totalBytes: number;
  bytesSent: number;
  startTime: number | null;
  endTime: number | null;
  sha256Local: string;
  sha256Remote: string;
  verified: boolean | null;
  speedMBps: number | null;
}

export interface Scenario3State {
  tick: number;
  snakes: SnakeState[];
  food: Position;
  scores: Record<string, number>;
  gameOver: boolean;
  pingMs: number | null;
}

export interface SnakeState {
  id: string;
  body: Position[];
  direction: Direction;
  alive: boolean;
}

export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
export type Position = { x: number; y: number };

export interface Scenario4State {
  framesSent: number;
  framesDropped: number;
  fps: number;
  startTime: number | null;
}

export interface AppState {
  connectionState: string;
  peerId: string | null;
  scenario1: Scenario1State;
  scenario2: Scenario2State;
  scenario3: Scenario3State;
  scenario4: Scenario4State;
}

export class AppStateManager {
  private state: AppState = {
    connectionState: 'new',
    peerId: null,
    scenario1: {
      files: [],
      totalFiles: 0,
      completedFiles: 0,
      startTime: null,
      endTime: null,
    },
    scenario2: {
      totalBytes: 0,
      bytesSent: 0,
      startTime: null,
      endTime: null,
      sha256Local: '',
      sha256Remote: '',
      verified: null,
      speedMBps: null,
    },
    scenario3: {
      tick: 0,
      snakes: [],
      food: { x: 5, y: 5 },
      scores: {},
      gameOver: false,
      pingMs: null,
    },
    scenario4: {
      framesSent: 0,
      framesDropped: 0,
      fps: 0,
      startTime: null,
    },
  };

  private listeners: Array<(s: AppState) => void> = [];

  update(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  updateScenario1(partial: Partial<Scenario1State>): void {
    this.state = {
      ...this.state,
      scenario1: { ...this.state.scenario1, ...partial },
    };
    this.emit();
  }

  updateScenario2(partial: Partial<Scenario2State>): void {
    this.state = {
      ...this.state,
      scenario2: { ...this.state.scenario2, ...partial },
    };
    this.emit();
  }

  updateScenario3(partial: Partial<Scenario3State>): void {
    this.state = {
      ...this.state,
      scenario3: { ...this.state.scenario3, ...partial },
    };
    this.emit();
  }

  updateScenario4(partial: Partial<Scenario4State>): void {
    this.state = {
      ...this.state,
      scenario4: { ...this.state.scenario4, ...partial },
    };
    this.emit();
  }

  get(): AppState {
    return this.state;
  }

  subscribe(listener: (s: AppState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) {
      l(this.state);
    }
  }
}
