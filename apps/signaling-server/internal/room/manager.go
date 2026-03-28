package room

import (
	"sync"
)

// Manager manages multiple rooms with concurrent-safe access.
type Manager struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

// NewManager creates a new Manager.
func NewManager() *Manager {
	return &Manager{
		rooms: make(map[string]*Room),
	}
}

// GetOrCreate returns an existing room or creates a new one.
func (m *Manager) GetOrCreate(name string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r, ok := m.rooms[name]; ok {
		return r
	}
	r := NewRoom()
	m.rooms[name] = r
	return r
}

// Cleanup removes the room if it is empty.
func (m *Manager) Cleanup(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r, ok := m.rooms[name]; ok && r.Empty() {
		delete(m.rooms, name)
	}
}
