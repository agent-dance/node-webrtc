import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';

enum SignalingState { disconnected, connecting, connected }
enum SignalingRole { offerer, answerer, auto }

typedef MessageHandler = void Function(Map<String, dynamic> msg);

SignalingRole _parseSignalingRole(String? raw, SignalingRole fallback) {
  switch (raw) {
    case 'offerer':
      return SignalingRole.offerer;
    case 'answerer':
      return SignalingRole.answerer;
    case 'auto':
      return SignalingRole.auto;
    default:
      return fallback;
  }
}

String _signalingRoleWire(SignalingRole role) => role.name;

class SignalingService extends ChangeNotifier {
  static const _signalingUrl = 'ws://localhost:8080/ws';
  static const _roomId = String.fromEnvironment('DEMO_ROOM_ID', defaultValue: 'demo');
  static const _peerId = String.fromEnvironment('DEMO_PEER_ID', defaultValue: 'flutter-b');

  WebSocketChannel? _channel;
  SignalingState _state = SignalingState.disconnected;
  String? _remotePeerId;
  SignalingRole? _remoteRole;

  final List<MessageHandler> _handlers = [];
  final SignalingRole _localRole = _parseSignalingRole(
    const String.fromEnvironment('DEMO_SIGNALING_ROLE', defaultValue: 'answerer'),
    SignalingRole.answerer,
  );

  SignalingState get state => _state;
  String? get remotePeerId => _remotePeerId;
  SignalingRole? get remoteRole => _remoteRole;
  SignalingRole get localRole => _localRole;

  void connect() {
    if (_state != SignalingState.disconnected) return;
    _state = SignalingState.connecting;
    notifyListeners();

    _channel = IOWebSocketChannel.connect(Uri.parse(_signalingUrl));
    _state = SignalingState.connected;
    notifyListeners();

    // Join room
    _send({
      'type': 'join',
      'room': _roomId,
      'id': _peerId,
      'role': _signalingRoleWire(_localRole),
    });

    _channel!.stream.listen(
      (data) {
        final msg = jsonDecode(data as String) as Map<String, dynamic>;
        _handleMessage(msg);
      },
      onDone: () {
        debugPrint('[Signaling] Disconnected');
        _state = SignalingState.disconnected;
        notifyListeners();
      },
      onError: (e) {
        debugPrint('[Signaling] Error: $e');
        _state = SignalingState.disconnected;
        notifyListeners();
      },
    );
  }

  void disconnect() {
    _send({'type': 'leave'});
    _channel?.sink.close();
    _state = SignalingState.disconnected;
    _remotePeerId = null;
    _remoteRole = null;
    notifyListeners();
  }

  void sendOffer(Map<String, dynamic> offer) =>
      _send({'type': 'offer', 'payload': offer});

  void sendAnswer(Map<String, dynamic> answer) =>
      _send({'type': 'answer', 'payload': answer});

  void sendCandidate(Map<String, dynamic> candidate) =>
      _send({'type': 'candidate', 'payload': candidate});

  void addHandler(MessageHandler handler) {
    _handlers.add(handler);
  }

  void removeHandler(MessageHandler handler) {
    _handlers.remove(handler);
  }

  void _send(Map<String, dynamic> msg) {
    if (_channel != null) {
      _channel!.sink.add(jsonEncode(msg));
    }
  }

  void _handleMessage(Map<String, dynamic> msg) {
    final type = msg['type'] as String?;
    debugPrint('[Signaling] Received: $type');

    if (type == 'joined') {
      _remotePeerId = msg['peerId'] as String?;
      _remoteRole = _parseSignalingRole(msg['role'] as String?, SignalingRole.auto);
      notifyListeners();
    } else if (type == 'peer-joined') {
      _remotePeerId = msg['peerId'] as String?;
      _remoteRole = _parseSignalingRole(msg['role'] as String?, SignalingRole.auto);
      notifyListeners();
    } else if (type == 'peer-left') {
      _remotePeerId = null;
      _remoteRole = null;
      notifyListeners();
    }

    for (final handler in List.from(_handlers)) {
      handler(msg);
    }
  }
}
