@webrtc @dtls-role
Feature: DTLS Role Negotiation (RFC 5763 §5)
  As a developer building on ts-rtc
  I want the DTLS role to be correctly determined from SDP negotiation
  So that peers never end up with matching roles (client+client or server+server)
  which would cause a handshake deadlock

  # ─── SDP-level role assignment ───────────────────────────────────────────────

  Scenario: Offerer SDP always advertises actpass
    Given a new RTCPeerConnection as offerer
    When offerer creates an offer
    Then the offer SDP must contain "a=setup:actpass"
    And the offer SDP must not contain "a=setup:active"
    And the offer SDP must not contain "a=setup:passive"

  Scenario: Answerer chooses active when offer is actpass (standard path)
    # RFC 5763 §5: when offerer sends actpass, answerer SHOULD be active (DTLS client)
    Given a new RTCPeerConnection as offerer
    And a new RTCPeerConnection as answerer
    When offerer creates an offer
    And answerer receives the offer as remote description
    And answerer creates an answer
    Then the answer SDP must contain "a=setup:active"
    And the answer SDP must not contain "a=setup:passive"

  Scenario: Answerer chooses passive when remote offer explicitly uses active
    # Remote (non-standard) sends active → local answerer must respond passive (DTLS server)
    Given a new RTCPeerConnection as answerer
    When answerer receives a remote SDP with "a=setup:active"
    And answerer creates an answer from that remote description
    Then the answer SDP must contain "a=setup:passive"
    And the answer SDP must not contain "a=setup:active"

  Scenario: Answerer chooses active when remote offer explicitly uses passive
    # Remote sends passive (DTLS server) → local answerer must be active (DTLS client)
    Given a new RTCPeerConnection as answerer
    When answerer receives a remote SDP with "a=setup:passive"
    And answerer creates an answer from that remote description
    Then the answer SDP must contain "a=setup:active"
    And the answer SDP must not contain "a=setup:passive"

  # ─── End-to-end role correctness ─────────────────────────────────────────────

  Scenario: Full offer/answer negotiation produces complementary DTLS roles
    # After complete SDP exchange, offerer and answerer must have opposite roles.
    # offerer → actpass → answerer replies active → offerer becomes server.
    # This prevents the "both-client deadlock" regression.
    Given a new RTCPeerConnection as offerer
    And a new RTCPeerConnection as answerer
    And ICE candidates are exchanged between offerer and answerer
    When full offer/answer negotiation completes between offerer and answerer
    Then the offer SDP must contain "a=setup:actpass"
    And the answer SDP must contain "a=setup:active"
    And both peers should reach "connected" connection state within 15 seconds

  Scenario: Connection succeeds and data channel works with correct role assignment
    Given a new RTCPeerConnection as offerer
    And a new RTCPeerConnection as answerer
    And ICE candidates are exchanged between offerer and answerer
    And offerer creates a data channel "role-test"
    When full offer/answer negotiation completes between offerer and answerer
    Then both peers should reach "connected" connection state within 15 seconds
    And the offerer should be able to send "role verified" on channel "role-test"
    And the answerer peer should receive "role verified" on channel "role-test"

  # ─── Regression: both-sides-same-role deadlock ───────────────────────────────

  Scenario: Loopback connection completes (not both-client)
    # This is the end-to-end regression test: if the DTLS role bug exists,
    # both sides would become "client" and the connection state would never
    # reach "connected" (it would time out as "failed").
    Given a new RTCPeerConnection as offerer
    And a new RTCPeerConnection as answerer
    And ICE candidates are exchanged between offerer and answerer
    And offerer creates a data channel "regression-check"
    When full offer/answer negotiation completes between offerer and answerer
    Then both peers should reach "connected" connection state within 15 seconds
