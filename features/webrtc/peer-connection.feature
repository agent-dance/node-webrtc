Feature: WebRTC Data Channel Communication
  As a developer using ts-rtc
  I want to exchange messages through WebRTC data channels
  So that I can build real-time peer-to-peer applications

  Background:
    Given two RTCPeerConnection instances "offerer" and "answerer"
    And trickle ICE candidates are exchanged between peers

  Scenario: Basic offer/answer negotiation
    When the offerer creates an offer
    And the offerer sets the offer as local description
    And the answerer sets the offer as remote description
    And the answerer creates an answer
    And the answerer sets the answer as local description
    And the offerer sets the answer as remote description
    Then the offerer signaling state should be "stable"
    And the answerer signaling state should be "stable"

  Scenario: Establishing a peer connection
    Given the offerer has a data channel "test"
    When offer/answer negotiation completes
    Then both peers should reach "connected" connection state within 15 seconds

  Scenario: Bidirectional data channel messaging
    Given the offerer has a data channel "chat"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends "Hello from offerer!" on channel "chat"
    Then the answerer should receive "Hello from offerer!" on channel "chat"
    When the answerer replies "Hello back from answerer!" on channel "chat"
    Then the offerer should receive "Hello back from answerer!" on channel "chat"

  Scenario: Binary data exchange
    Given the offerer has a data channel "binary"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends binary data of 1024 bytes on channel "binary"
    Then the answerer should receive binary data of 1024 bytes on channel "binary"

  Scenario: Large message exchange (fragmentation)
    Given the offerer has a data channel "large"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends binary data of 65536 bytes on channel "large"
    Then the answerer should receive binary data of 65536 bytes on channel "large"

  Scenario: Multiple concurrent data channels
    Given the offerer has a data channel "channel-1"
    And the offerer has a data channel "channel-2"
    And the offerer has a data channel "channel-3"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends "msg1" on channel "channel-1"
    And the offerer sends "msg2" on channel "channel-2"
    And the offerer sends "msg3" on channel "channel-3"
    Then the answerer should receive "msg1" on channel "channel-1"
    And the answerer should receive "msg2" on channel "channel-2"
    And the answerer should receive "msg3" on channel "channel-3"

  Scenario: Data channel created after connection
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer creates a data channel "late-channel" after connection
    Then the answerer should receive a data channel named "late-channel"
    And the channel "late-channel" should be open within 5 seconds

  Scenario: Pre-negotiated data channel (negotiated=true)
    And offer/answer negotiation completes
    And both peers are connected
    When both peers create a pre-negotiated channel "secure" with id 5
    Then channel "secure" should be open on both peers within 5 seconds
    When the offerer sends "negotiated message" on channel "secure"
    Then the answerer should receive "negotiated message" on channel "secure"

  Scenario: Unordered data channel
    Given the offerer has an unordered data channel "unordered"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends "unordered-1" on channel "unordered"
    And the offerer sends "unordered-2" on channel "unordered"
    Then the answerer should receive "unordered-1" on channel "unordered"
    And the answerer should receive "unordered-2" on channel "unordered"

  Scenario: Channel close and cleanup
    Given the offerer has a data channel "ephemeral"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends "before close" on channel "ephemeral"
    Then the answerer should receive "before close" on channel "ephemeral"
    When the channel "ephemeral" is closed by the offerer
    Then the channel "ephemeral" should reach "closed" state on the offerer

  Scenario: Signaling state transitions
    When the offerer creates an offer
    And the offerer sets the offer as local description
    Then the offerer signaling state should be "have-local-offer"
    When the answerer sets the offer as remote description
    Then the answerer signaling state should be "have-remote-offer"
    When the answerer creates an answer
    And the answerer sets the answer as local description
    Then the answerer signaling state should be "stable"
    When the offerer sets the answer as remote description
    Then the offerer signaling state should be "stable"

  Scenario: Graceful close
    Given the offerer has a data channel "test"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer closes the connection
    Then the offerer connection state should be "closed"

  Scenario: getStats returns meaningful data
    Given the offerer has a data channel "stats-test"
    And offer/answer negotiation completes
    And both peers are connected
    Then the offerer stats should contain a candidate pair entry

  Scenario: Very large file transfer (4 MiB, end-to-end integrity check)
    Given the offerer has a data channel "file-transfer"
    And offer/answer negotiation completes
    And both peers are connected
    When the offerer sends binary data of 4194304 bytes on channel "file-transfer"
    Then the answerer should receive binary data of 4194304 bytes on channel "file-transfer"
    And the received data on channel "file-transfer" should be byte-for-byte correct
