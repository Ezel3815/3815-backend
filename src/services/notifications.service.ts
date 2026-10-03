import 'dart:convert';
import 'dart:math';

import 'package:upgrade/services/notification_pools.dart';

/// Where the engine keeps its state. The app uses SharedPreferences; the
/// in-app self-test uses memory so it never touches real data.
abstract class NeStore {
  String? read();
  Future<void> write(String json);
}

class MemoryNeStore implements NeStore {
  String? _v;
  @override
  String? read() => _v;
  @override
  Future<void> write(String json) async => _v = json;
}

/// Daily study state. Synchronised with the server (see
/// NotificationService.syncWithServer) so another device can't leave reminders on.
enum StudyState { notStudied, enteredApp, studying, studiedToday }

enum Slot { morning, daily, passive, late }

class EngineConfig {
  final bool remindersEnabled; // morning + daily + passive
  final bool lateEnabled; // streak-protection slot
  final int morningMinutes;
  final int dailyMinutes;
  final int lateMinutes;
  final Duration cooldown;
  /// Calendar days treated as weekend. (Saudi Arabia is Fri–Sat — change here
  /// if you want that instead of Sat–Sun.)
  final Set<int> weekendDays;

  const EngineConfig({
    this.remindersEnabled = true,
    this.lateEnabled = true,
    this.morningMinutes = 9 * 60 + 30,
    this.dailyMinutes = 14 * 60,
    this.lateMinutes = 21 * 60 + 30,
    this.cooldown = const Duration(minutes: 120),
    this.weekendDays = const {DateTime.saturday, DateTime.sunday},
  });

  int get passiveMinutes => dailyMinutes + 240;
}

class PlannedNotification {
  final String clientId;
  final Slot slot;
  final NotifPool pool;
  final bool weekend;
  final int messageIndex;
  final String message;
  final DateTime at;
  final int dayOffset;
  const PlannedNotification({
    required this.clientId,
    required this.slot,
    required this.pool,
    required this.weekend,
    required this.messageIndex,
    required this.message,
    required this.at,
    required this.dayOffset,
  });
}

/// One notification's full lifecycle — the analytics record.
class NotifRecord {
  String clientId;
  String type; // slot name or 'challenge_invite'
  String pool; // pool name or 'challenge'
  bool weekend;
  int messageIndex;
  String message;
  DateTime at;
  String status; // planned | sent | cancelled
  DateTime? openedAt;
  bool appOpened;
  bool studied;
  DateTime? sessionStartedAt;
  int cards;
  bool converted;
  int? challengeId;
  int? friendId;
  bool dirty;

  NotifRecord({
    required this.clientId,
    required this.type,
    required this.pool,
    required this.weekend,
    required this.messageIndex,
    required this.message,
    required this.at,
    this.status = 'planned',
    this.openedAt,
    this.appOpened = false,
    this.studied = false,
    this.sessionStartedAt,
    this.cards = 0,
    this.converted = false,
    this.challengeId,
    this.friendId,
    this.dirty = false,
  });

  Map<String, dynamic> toJson() => {
        'id': clientId,
        'type': type,
        'pool': pool,
        'we': weekend,
        'idx': messageIndex,
        'msg': message,
        'at': at.millisecondsSinceEpoch,
        'st': status,
        'op': openedAt?.millisecondsSinceEpoch,
        'ao': appOpened,
        'sd': studied,
        'ss': sessionStartedAt?.millisecondsSinceEpoch,
        'cc': cards,
        'cv': converted,
        'ch': challengeId,
        'fr': friendId,
        'dy': dirty,
      };

  static DateTime? _d(dynamic v) =>
      v == null ? null : DateTime.fromMillisecondsSinceEpoch(v as int);

  factory NotifRecord.fromJson(Map<String, dynamic> j) => NotifRecord(
        clientId: j['id'],
        type: j['type'],
        pool: j['pool'],
        weekend: j['we'] ?? false,
        messageIndex: j['idx'] ?? 0,
        message: j['msg'] ?? '',
        at: DateTime.fromMillisecondsSinceEpoch(j['at']),
        status: j['st'] ?? 'planned',
        openedAt: _d(j['op']),
        appOpened: j['ao'] ?? false,
        studied: j['sd'] ?? false,
        sessionStartedAt: _d(j['ss']),
        cards: j['cc'] ?? 0,
        converted: j['cv'] ?? false,
        challengeId: j['ch'],
        friendId: j['fr'],
        dirty: j['dy'] ?? false,
      );

  /// Shape the backend's /users/me/notification-events expects.
  Map<String, dynamic> toApi() => {
        'client_id': clientId,
        'notification_type': type,
        'notification_pool': pool,
        'message': message,
        'sent_at': at.toUtc().toIso8601String(),
        if (openedAt != null) 'opened_at': openedAt!.toUtc().toIso8601String(),
        'app_opened_after_notification': appOpened,
        'studied_after_notification': studied,
        if (sessionStartedAt != null)
          'study_session_started_at': sessionStartedAt!.toUtc().toIso8601String(),
        'cards_completed_after_notification': cards,
        'notification_converted_to_study': converted,
        if (challengeId != null) 'challenge_id': challengeId,
        if (friendId != null) 'friend_id': friendId,
      };
}

/// Decides WHICH notification (if any) comes next. It never sends anything
/// itself and has no Flutter/plugin dependency, so it can be tested in-app
/// with a fake clock (see notification_selftest.dart).
///
/// Order of decisions: study state → time slot → pool → (only then) random
/// message inside that pool, avoiding recently used messages.
class NotificationEngine {
  NotificationEngine(this._store, {Random? random}) : _rnd = random ?? Random() {
    _load();
  }

  final NeStore _store;
  final Random _rnd;
  String _day = '';
  StudyState _state = StudyState.notStudied;
  final List<NotifRecord> _records = [];

  static const int _maxRecords = 90;

  // ───────────── persistence ─────────────
  void _load() {
    final raw = _store.read();
    if (raw == null || raw.isEmpty) return;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      _day = j['day'] ?? '';
      _state = StudyState.values[(j['state'] ?? 0) as int];
      _records
        ..clear()
        ..addAll((j['recs'] as List? ?? [])
            .map((e) => NotifRecord.fromJson(Map<String, dynamic>.from(e))));
    } catch (_) {
      // Corrupt blob: start clean rather than crash the app.
    }
  }

  Future<void> _save() {
    if (_records.length > _maxRecords) {
      _records.sort((a, b) => a.at.compareTo(b.at));
      _records.removeRange(0, _records.length - _maxRecords);
    }
    return _store.write(jsonEncode({
      'day': _day,
      'state': _state.index,
      'recs': _records.map((r) => r.toJson()).toList(),
    }));
  }

  static String dayKey(DateTime d) => '${d.year}-${d.month}-${d.day}';

  // ───────────── study state ─────────────
  StudyState stateAt(DateTime now) =>
      _day == dayKey(now) ? _state : StudyState.notStudied;

  bool studiedToday(DateTime now) => stateAt(now) == StudyState.studiedToday;

  void _setState(DateTime now, StudyState s) {
    _day = dayKey(now);
    _state = s;
  }

  /// App opened / foregrounded. Does NOT stop reminders.
  Future<void> markEntered(DateTime now) async {
    if (stateAt(now) == StudyState.notStudied) {
      _setState(now, StudyState.enteredApp);
    }
    // Opened the app shortly after a notification (without tapping it).
    for (final r in _records) {
      if (r.status == 'sent' &&
          !r.appOpened &&
          now.difference(r.at).inMinutes >= 0 &&
          now.difference(r.at).inMinutes <= 30) {
        r.appOpened = true;
        r.dirty = true;
      }
    }
    await _save();
  }

  /// A study session was started.
  Future<void> markStudying(DateTime now) async {
    if (!studiedToday(now)) _setState(now, StudyState.studying);
    final r = _latestSentToday(now);
    if (r != null && r.sessionStartedAt == null) {
      r.sessionStartedAt = now;
      r.appOpened = true;
      r.dirty = true;
    }
    await _save();
  }

  /// The user really studied (first confirmed answer of the day).
  /// Cancels every remaining reminder for today; tomorrow starts fresh.
  Future<void> markStudied(DateTime now, {int cards = 1}) async {
    final first = !studiedToday(now);
    _setState(now, StudyState.studiedToday);
    final r = _latestSentToday(now);
    if (r != null) {
      r.studied = true;
      r.converted = true;
      r.appOpened = true;
      r.cards += cards;
      r.dirty = true;
    }
    if (first) {
      for (final p in _records) {
        if (p.status == 'planned' && dayKey(p.at) == dayKey(now)) {
          p.status = 'cancelled';
        }
      }
    }
    await _save();
  }

  /// Server says the user already studied today (e.g. on another device).
  Future<void> applyServerStudied(DateTime now) async {
    if (studiedToday(now)) return;
    _setState(now, StudyState.studiedToday);
    for (final p in _records) {
      if (p.status == 'planned' && dayKey(p.at) == dayKey(now)) {
        p.status = 'cancelled';
      }
    }
    await _save();
  }

  NotifRecord? _latestSentToday(DateTime now) {
    NotifRecord? best;
    for (final r in _records) {
      if (r.status != 'sent' || dayKey(r.at) != dayKey(now)) continue;
      if (now.difference(r.at).inHours > 14) continue;
      if (best == null || r.at.isAfter(best.at)) best = r;
    }
    return best;
  }

  // ───────────── records / analytics ─────────────
  List<NotifRecord> get records => List.unmodifiable(_records);

  Future<void> recordOpened(String clientId, DateTime now) async {
    for (final r in _records) {
      if (r.clientId == clientId) {
        r.openedAt ??= now;
        r.appOpened = true;
        r.dirty = true;
      }
    }
    await _save();
  }

  /// Push-delivered events (e.g. friend challenge) that the server sent.
  Future<void> recordExternal({
    required String clientId,
    required String type,
    required String message,
    required DateTime sentAt,
    bool opened = false,
    int? challengeId,
    int? friendId,
  }) async {
    var r = _records.where((e) => e.clientId == clientId).firstOrNull;
    r ??= NotifRecord(
      clientId: clientId,
      type: type,
      pool: 'challenge',
      weekend: false,
      messageIndex: 0,
      message: message,
      at: sentAt,
      status: 'sent',
      challengeId: challengeId,
      friendId: friendId,
    )..dirty = true;
    if (!_records.contains(r)) _records.add(r);
    if (opened) {
      r.openedAt ??= DateTime.now();
      r.appOpened = true;
      r.dirty = true;
    }
    await _save();
  }

  List<NotifRecord> dirtyRecords() =>
      _records.where((r) => r.dirty && r.status == 'sent').toList();

  Future<void> markUploaded(Iterable<String> ids) async {
    final set = ids.toSet();
    for (final r in _records) {
      if (set.contains(r.clientId)) r.dirty = false;
    }
    await _save();
  }

  /// Planned notifications whose time has passed are now "sent" (the OS
  /// delivered them; a device can't observe delivery directly).
  void reconcile(DateTime now) {
    for (final r in _records) {
      if (r.status == 'planned' && !r.at.isAfter(now)) {
        r.status = 'sent';
        r.dirty = true;
      }
    }
  }

  DateTime? _lastSentAt() {
    DateTime? last;
    for (final r in _records) {
      if (r.status == 'sent' && (last == null || r.at.isAfter(last))) last = r.at;
    }
    return last;
  }

  // ───────────── planning ─────────────
  bool isWeekend(DateTime d, EngineConfig cfg) => cfg.weekendDays.contains(d.weekday);

  NotifPool _poolFor(Slot slot, bool weekend, int dueCount, int dayOffset) {
    switch (slot) {
      case Slot.morning:
        return NotifPool.morning;
      case Slot.daily:
        if (dueCount > 0) return NotifPool.review;
        if (weekend && _rnd.nextDouble() < 0.35) return NotifPool.weekendExtra;
        return NotifPool.daily;
      case Slot.passive:
      case Slot.late:
        return NotifPool.passive;
    }
  }

  int _pickIndex(NotifPool pool, bool weekend, Set<int> usedInPlan, int streak, Slot slot) {
    final list = NotificationPools.list(pool, weekend: weekend);
    final key = '${pool.name}_${weekend ? 'we' : 'wd'}';
    final recent = <int>{...usedInPlan};
    final hist = _records
        .where((r) =>
            r.status != 'cancelled' && '${r.pool}_${r.weekend ? 'we' : 'wd'}' == key)
        .toList()
      ..sort((a, b) => b.at.compareTo(a.at));
    final window = max(1, min(list.length - 1, 6));
    for (final r in hist.take(window)) {
      recent.add(r.messageIndex);
    }
    var candidates = [for (var i = 0; i < list.length; i++) if (!recent.contains(i)) i];
    if (candidates.isEmpty) {
      candidates = [for (var i = 0; i < list.length; i++) if (i != (hist.isEmpty ? -1 : hist.first.messageIndex)) i];
    }
    // Late-evening nudge with a live streak: prefer messages about the streak.
    if (slot == Slot.late && streak >= 3) {
      final s = candidates.where((i) => list[i].contains('سلسل')).toList();
      if (s.isNotEmpty) candidates = s;
    }
    return candidates[_rnd.nextInt(candidates.length)];
  }

  List<(Slot, int)> _slots(EngineConfig cfg) {
    final out = <(Slot, int)>[];
    if (cfg.remindersEnabled) {
      out.add((Slot.morning, cfg.morningMinutes));
      out.add((Slot.daily, cfg.dailyMinutes));
      final passive = cfg.passiveMinutes;
      final lateOk = !cfg.lateEnabled ||
          cfg.lateMinutes - passive >= cfg.cooldown.inMinutes;
      if (lateOk && passive < 22 * 60) out.add((Slot.passive, passive));
    }
    if (cfg.lateEnabled) out.add((Slot.late, cfg.lateMinutes));
    out.sort((a, b) => a.$2.compareTo(b.$2));
    return out;
  }

  /// All notifications that should be scheduled from [now] for the next
  /// [days] days. Pure: stores nothing (see [planAndStore]).
  List<PlannedNotification> planAhead({
    required DateTime now,
    EngineConfig cfg = const EngineConfig(),
    int days = 7,
    int dueCount = 0,
    int streak = 0,
    bool? weekendOverride,
    bool ignoreCooldown = false,
  }) {
    final plan = <PlannedNotification>[];
    final usedByKey = <String, Set<int>>{};
    var lastAt = ignoreCooldown ? null : _lastSentAt();

    for (var d = 0; d < days; d++) {
      final day = DateTime(now.year, now.month, now.day + d);
      if (d == 0 && studiedToday(now)) continue; // studied → nothing more today
      final weekend = weekendOverride ?? isWeekend(day, cfg);
      for (final (slot, minutes) in _slots(cfg)) {
        final at = DateTime(day.year, day.month, day.day, minutes ~/ 60, minutes % 60);
        if (!at.isAfter(now.add(const Duration(seconds: 5)))) continue;
        if (lastAt != null && at.difference(lastAt) < cfg.cooldown) continue;
        final pool = _poolFor(slot, weekend, dueCount, d);
        final key = '${pool.name}_${weekend ? 'we' : 'wd'}';
        final used = usedByKey.putIfAbsent(key, () => <int>{});
        final idx = _pickIndex(pool, weekend, used, streak, slot);
        used.add(idx);
        plan.add(PlannedNotification(
          clientId: '${at.millisecondsSinceEpoch}-${slot.name}',
          slot: slot,
          pool: pool,
          weekend: weekend,
          messageIndex: idx,
          message: NotificationPools.list(pool, weekend: weekend)[idx],
          at: at,
          dayOffset: d,
        ));
        lastAt = at;
      }
    }
    return plan;
  }

  /// The single next notification (or null when nothing should be sent).
  PlannedNotification? getNextNotification({
    required DateTime now,
    EngineConfig cfg = const EngineConfig(),
    int dueCount = 0,
    int streak = 0,
    bool? weekendOverride,
  }) {
    final p = planAhead(
      now: now,
      cfg: cfg,
      days: 2,
      dueCount: dueCount,
      streak: streak,
      weekendOverride: weekendOverride,
    );
    return p.isEmpty ? null : p.first;
  }

  /// Replaces the stored plan: old still-planned entries are dropped, the
  /// new plan is saved as "planned" (so later picks avoid repeating it).
  Future<List<PlannedNotification>> planAndStore({
    required DateTime now,
    EngineConfig cfg = const EngineConfig(),
    int days = 7,
    int dueCount = 0,
    int streak = 0,
  }) async {
    reconcile(now);
    _records.removeWhere((r) => r.status == 'planned' || r.status == 'cancelled');
    final plan = planAhead(
        now: now, cfg: cfg, days: days, dueCount: dueCount, streak: streak);
    for (final p in plan) {
      _records.add(NotifRecord(
        clientId: p.clientId,
        type: p.slot.name,
        pool: p.pool.name,
        weekend: p.weekend,
        messageIndex: p.messageIndex,
        message: p.message,
        at: p.at,
      ));
    }
    await _save();
    return plan;
  }

  /// Test helper: forget everything.
  Future<void> reset() async {
    _day = '';
    _state = StudyState.notStudied;
    _records.clear();
    await _save();
  }
}
