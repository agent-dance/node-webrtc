package room

import (
	"sync"
)

// Peer represents a connected client in a room
type Peer struct {
	ID   string
	Role string
	Send chan []byte
}

// Room holds at most 2 peers
type Room struct {
	mu    sync.RWMutex
	peers map[string]*Peer
}

// NewRoom creates an empty room
func NewRoom() *Room {
	return &Room{
		peers: make(map[string]*Peer),
	}
}

// Join adds a peer to the room. Returns the existing peer (if any) and ok=false
// when the room is already full.
func (r *Room) Join(id string, role string, send chan []byte) (*Peer, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.peers) >= 2 {
		return nil, false
	}

	var existing *Peer
	for _, peer := range r.peers {
		existing = peer
	}

	r.peers[id] = &Peer{ID: id, Role: role, Send: send}
	return existing, true
}

// Leave removes a peer and returns the remaining peer ID (empty if none).
func (r *Room) Leave(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.peers, id)

	for pid := range r.peers {
		return pid
	}
	return ""
}

// Peer returns the peer with the given id.
func (r *Room) Peer(id string) (*Peer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.peers[id]
	return p, ok
}

// Other returns the peer that is NOT the given id.
func (r *Room) Other(id string) (*Peer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for pid, p := range r.peers {
		if pid != id {
			return p, true
		}
	}
	return nil, false
}

// Empty returns true when no peers are present.
func (r *Room) Empty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers) == 0
}
