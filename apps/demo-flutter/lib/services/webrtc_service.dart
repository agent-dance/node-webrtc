import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'signaling_service.dart';
import '../scenarios/file_transfer_handler.dart';
import '../scenarios/large_file_handler.dart';
import '../scenarios/snake_game_handler.dart';
import '../scenarios/video_receiver_handler.dart';

enum PeerConnectionState { newState, connecting, connected, disconnected, failed, closed }

bool _shouldInitiateConnection(
  SignalingRole localRole,
  String localPeerId,
  SignalingRole remoteRole,
  String remotePeerId,
) {
  const roleRank = {
    SignalingRole.answerer: 0,
    SignalingRole.auto: 1,
    SignalingRole.offerer: 2,
  };

  final localRank = roleRank[localRole]!;
  final remoteRank = roleRank[remoteRole]!;
  if (localRank != remoteRank) {
    return localRank > remoteRank;
  }
  return localPeerId.compareTo(remotePeerId) < 0;
}

class WebRtcService extends ChangeNotifier {
  final SignalingService _signaling;
  static const Map<String, dynamic> _dataOnlyOfferConstraints = {
    'mandatory': {
      'OfferToReceiveAudio': false,
      'OfferToReceiveVideo': false,
    },
    'optional': [],
  };

  RTCPeerConnection? _pc;
  RTCDataChannel? _bootstrapDataChannel;
  PeerConnectionState _connectionState = PeerConnectionState.newState;

  // Scenario handlers
  late final FileTransferHandler fileTransferHandler;
  late final LargeFileHandler largeFileHandler;
  late final SnakeGameHandler snakeGameHandler;
  late final VideoReceiverHandler videoReceiverHandler;

  // Candidate buffer
  final List<RTCIceCandidate> _candidateBuffer = [];
  bool _remoteDescriptionSet = false;

  PeerConnectionState get connectionState => _connectionState;

  WebRtcService(this._signaling) {
    fileTransferHandler = FileTransferHandler();
    largeFileHandler = LargeFileHandler();
    snakeGameHandler = SnakeGameHandler();
    videoReceiverHandler = VideoReceiverHandler();

    _signaling.addHandler(_handleSignalingMessage);
  }

  Future<void> _createPeerConnection() async {
    // Local loopback demo — no STUN needed, host candidates are sufficient
    final config = <String, dynamic>{
      'iceServers': <Map<String, dynamic>>[],
    };

    _pc = await createPeerConnection(config);

    _pc!.onConnectionState = (RTCPeerConnectionState state) {
      debugPrint('[WebRTC] connectionState: $state');
      _connectionState = _mapConnectionState(state);
      notifyListeners();
    };

    _pc!.onIceCandidate = (RTCIceCandidate candidate) {
      _signaling.sendCandidate({
        'candidate': candidate.candidate,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      });
    };

    _pc!.onDataChannel = (RTCDataChannel channel) {
      debugPrint('[WebRTC] DataChannel: ${channel.label}');
      _routeDataChannel(channel);
    };

    _pc!.onIceConnectionState = (RTCIceConnectionState state) {
      debugPrint('[WebRTC] iceConnectionState: $state');
    };
  }

  Future<void> _startCall(String remotePeerId) async {
    if (_pc != null) {
      await _pc!.close();
      _pc = null;
      _bootstrapDataChannel = null;
      _remoteDescriptionSet = false;
      _candidateBuffer.clear();
    }
    await _createPeerConnection();
    debugPrint('[WebRTC] Starting call with $remotePeerId as ${_signaling.localRole.name}');

    final bootstrapInit = RTCDataChannelInit();
    _bootstrapDataChannel =
        await _pc!.createDataChannel('role-bootstrap', bootstrapInit);
    final offer = await _pc!.createOffer(_dataOnlyOfferConstraints);
    await _pc!.setLocalDescription(offer);
    _signaling.sendOffer({'sdp': offer.sdp, 'type': offer.type});
  }

  void _routeDataChannel(RTCDataChannel channel) {
    final label = channel.label ?? '';

    if (label.startsWith('file-')) {
      fileTransferHandler.handleChannel(channel);
    } else if (label == 'large-file') {
      largeFileHandler.handleChannel(channel);
    } else if (label == 'snake-game') {
      snakeGameHandler.handleChannel(channel);
    } else if (label == 'video-stream') {
      videoReceiverHandler.handleChannel(channel);
    } else {
      debugPrint('[WebRTC] Unknown channel: $label');
    }
  }

  Future<void> _handleOffer(Map<String, dynamic> offer) async {
    // Always create a fresh peer connection for a new offer.
    // The previous connection (if any) must be torn down so we use the
    // new ICE credentials from the offer.
    if (_pc != null) {
      debugPrint('[WebRTC] Closing existing PC before handling new offer');
      await _pc!.close();
      _pc = null;
      _remoteDescriptionSet = false;
      _candidateBuffer.clear();
    }
    await _createPeerConnection();

    await _pc!.setRemoteDescription(
      RTCSessionDescription(offer['sdp'] as String, offer['type'] as String),
    );
    _remoteDescriptionSet = true;

    // Flush buffered candidates
    for (final c in _candidateBuffer) {
      await _pc!.addCandidate(c);
    }
    _candidateBuffer.clear();

    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);

    _signaling.sendAnswer({'sdp': answer.sdp, 'type': answer.type});
    debugPrint('[WebRTC] Answer sent');
  }

  Future<void> _handleAnswer(Map<String, dynamic> answer) async {
    if (_pc == null) return;

    await _pc!.setRemoteDescription(
      RTCSessionDescription(answer['sdp'] as String, answer['type'] as String),
    );
    _remoteDescriptionSet = true;

    for (final c in _candidateBuffer) {
      await _pc!.addCandidate(c);
    }
    _candidateBuffer.clear();
    await _bootstrapDataChannel?.close();
    _bootstrapDataChannel = null;
    debugPrint('[WebRTC] Remote answer applied');
  }

  Future<void> _handleCandidate(Map<String, dynamic> payload) async {
    final candidate = RTCIceCandidate(
      payload['candidate'] as String?,
      payload['sdpMid'] as String?,
      payload['sdpMLineIndex'] as int?,
    );

    if (_remoteDescriptionSet && _pc != null) {
      await _pc!.addCandidate(candidate);
    } else {
      _candidateBuffer.add(candidate);
    }
  }

  void _handleSignalingMessage(Map<String, dynamic> msg) {
    final type = msg['type'] as String?;
    switch (type) {
      case 'offer':
        final payload = msg['payload'] as Map<String, dynamic>;
        _handleOffer(payload);
        break;
      case 'answer':
        final payload = msg['payload'] as Map<String, dynamic>;
        _handleAnswer(payload);
        break;
      case 'candidate':
        final payload = msg['payload'] as Map<String, dynamic>;
        _handleCandidate(payload);
        break;
      case 'joined':
      case 'peer-joined':
        final remotePeerId = msg['peerId'] as String?;
        if (remotePeerId == null) break;
        final remoteRole = _signaling.remoteRole ?? SignalingRole.auto;
        final shouldInitiate = _shouldInitiateConnection(
          _signaling.localRole,
          const String.fromEnvironment('DEMO_PEER_ID', defaultValue: 'flutter-b'),
          remoteRole,
          remotePeerId,
        );
        debugPrint(
          '[WebRTC] role-decision local=${_signaling.localRole.name} remote=${remoteRole.name} '
          'peer=$remotePeerId initiate=$shouldInitiate',
        );
        if (shouldInitiate) {
          _startCall(remotePeerId);
        }
        break;
      case 'peer-left':
        // Only close if the WebRTC connection is not yet established AND
        // we are not in the process of setting up a new connection (offer
        // handling races can arrive interleaved with peer-left).
        if (_connectionState != PeerConnectionState.connected &&
            _connectionState != PeerConnectionState.connecting &&
            _pc == null) {
          close();
        }
        break;
    }
  }

  void close() {
    _bootstrapDataChannel?.close();
    _bootstrapDataChannel = null;
    _pc?.close();
    _pc = null;
    _remoteDescriptionSet = false;
    _candidateBuffer.clear();
    _connectionState = PeerConnectionState.closed;
    notifyListeners();
  }

  static PeerConnectionState _mapConnectionState(RTCPeerConnectionState state) {
    switch (state) {
      case RTCPeerConnectionState.RTCPeerConnectionStateNew:
        return PeerConnectionState.newState;
      case RTCPeerConnectionState.RTCPeerConnectionStateConnecting:
        return PeerConnectionState.connecting;
      case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
        return PeerConnectionState.connected;
      case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
        return PeerConnectionState.disconnected;
      case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
        return PeerConnectionState.failed;
      case RTCPeerConnectionState.RTCPeerConnectionStateClosed:
        return PeerConnectionState.closed;
    }
  }

  @override
  void dispose() {
    _signaling.removeHandler(_handleSignalingMessage);
    close();
    super.dispose();
  }
}
