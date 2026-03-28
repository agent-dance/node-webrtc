@sctp
Feature: SCTP Data Channels
  As a developer using ts-rtc
  I want SCTP associations to handle data channels
  So that WebRTC data channels can exchange messages

  Scenario: SCTP loopback handshake
    Given an SCTP client association on port 5000
    And an SCTP server association on port 5000
    And the associations are wired together
    When both associations connect
    Then both associations should be in "connected" state

  Scenario: DCEP data channel open
    Given a connected SCTP client-server pair
    When the client creates a data channel "test"
    Then the server should receive a "datachannel" event for "test"
    And the client channel should be in "open" state

  Scenario: Large binary transfer via SCTP (65 KiB)
    Given a connected SCTP async pair
    When the client creates a data channel "bigdata"
    And the client waits for channel "bigdata" to be open
    And the client sends binary data of 65536 bytes on SCTP channel "bigdata"
    Then the server should receive binary data of 65536 bytes on SCTP channel "bigdata"

  Scenario: Very large binary transfer via SCTP (4 MiB)
    Given a connected SCTP async pair
    When the client creates a data channel "huge"
    And the client waits for channel "huge" to be open
    And the client sends binary data of 4194304 bytes on SCTP channel "huge"
    Then the server should receive binary data of 4194304 bytes on SCTP channel "huge"
