package handler

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"signaling-server/internal/room"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Message is the generic signaling message envelope.
type Message struct {
	Type    string          `json:"type"`
	Room    string          `json:"room,omitempty"`
	ID      string          `json:"id,omitempty"`
	PeerID  string          `json:"peerId,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Handler holds shared state for the WS handler.
type Handler struct {
	manager *room.Manager
}

// New creates a new Handler.
func New(manager *room.Manager) *Handler {
	return &Handler{manager: manager}
}

// ServeWS handles WebSocket upgrade and message routing.
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	send := make(chan []byte, 64)

	// Write pump
	go func() {
		defer conn.Close()
		for msg := range send {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("write error: %v", err)
				return
			}
		}
	}()

	var (
		peerID   string
		roomName string
		rm       *room.Room
	)

	defer func() {
		close(send)
		if rm != nil && peerID != "" {
			remaining := rm.Leave(peerID)
			h.manager.Cleanup(roomName)

			// Notify remaining peer
			if remaining != "" {
				if other, ok := rm.Peer(remaining); ok {
					sendMsg(other.Send, Message{
						Type:   "peer-left",
						PeerID: peerID,
					})
				}
			}
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("json parse error: %v", err)
			continue
		}

		switch msg.Type {
		case "join":
			peerID = msg.ID
			roomName = msg.Room
			rm = h.manager.GetOrCreate(roomName)

			existingID, ok := rm.Join(peerID, send)
			if !ok {
				sendMsg(send, Message{Type: "error", Payload: json.RawMessage(`"room full"`)})
				continue
			}

			// Confirm join to the new peer
			sendMsg(send, Message{
				Type:   "joined",
				PeerID: existingID,
			})

			// Notify existing peer
			if existingID != "" {
				if other, ok := rm.Peer(existingID); ok {
					sendMsg(other.Send, Message{
						Type:   "peer-joined",
						PeerID: peerID,
					})
				}
			}

		case "offer", "answer", "candidate":
			// Relay to the other peer in the room
			if rm == nil {
				continue
			}
			if other, ok := rm.Other(peerID); ok {
				relay := Message{
					Type:    msg.Type,
					Payload: msg.Payload,
				}
				sendMsg(other.Send, relay)
			}

		case "leave":
			return
		}
	}
}

func sendMsg(ch chan []byte, msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case ch <- data:
	default:
		log.Println("send channel full, dropping message")
	}
}
