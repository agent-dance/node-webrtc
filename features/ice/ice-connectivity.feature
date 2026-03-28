@ice
Feature: ICE Connectivity
  As a developer using ts-rtc
  I want ICE agents to establish connectivity
  So that peers can communicate over UDP

  Scenario: ICE agent gathering produces host candidates
    Given a new ICE agent with role "controlling"
    When the agent gathers candidates
    Then at least one host candidate should be produced
    And all candidates should have a valid foundation, transport, priority, address, and port

  Scenario: ICE loopback connectivity
    Given two ICE agents "agent-a" (controlling) and "agent-b" (controlled)
    And the agents have exchanged parameters
    When both agents gather candidates and connect
    Then both agents should be in "connected" state
    And data sent by agent-a should be received by agent-b
