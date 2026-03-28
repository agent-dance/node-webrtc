@dtls
Feature: DTLS Handshake
  As a developer using ts-rtc
  I want DTLS to complete a handshake
  So that encrypted communication is established

  Scenario: DTLS client-server loopback handshake
    Given a DTLS client transport
    And a DTLS server transport
    And the transports are wired together
    When both transports start the DTLS handshake
    Then both should reach "connected" state
    And both should have matching SRTP keying material

  Scenario: DTLS application data exchange
    Given a connected DTLS client-server pair
    When the client sends application data "Hello DTLS!"
    Then the server should receive "Hello DTLS!"
