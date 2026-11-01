#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <Servo.h>
#include <EEPROM.h>
#include "secrets.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

// Motion model: left sweep, right sweep, and body tilt. Physical directions
// must be confirmed and configured before walking is enabled.
constexpr int pins[3] = {14, 12, 13}; // D5, D6, D7
constexpr int CENTER = 1500;
constexpr int HARD_MIN = 900, HARD_MAX = 2100;
constexpr int MAX_ACTIONS = 16;
struct Action { int left, right, steps, speed; };
Action actions[MAX_ACTIONS];
int actionCount = 0, actionIndex = 0, stepIndex = 0, phase = 0;
int signs[3] = {0, 0, 0};
int center[3] = {CENTER, CENTER, CENTER};
int amplitude[3] = {100, 100, 100};
int lowLimit[3] = {1250, 1250, 1250};
int highLimit[3] = {1750, 1750, 1750};
uint32_t moveMs = 3000, settleMs = 750;
struct SavedTiming { uint32_t magic, move, settle, check; };
constexpr int TIMING_ADDRESS = 96;
bool validTiming(const SavedTiming &v) {
  return v.magic == 0x54494D45 && v.move >= 20 && v.move <= 60000 &&
    v.settle <= 60000 && v.check == (v.magic ^ v.move ^ v.settle ^ 0x9537AC12);
}
struct SavedCalibration {
  uint32_t magic, version;
  int32_t center[3], signs[3], amplitude[3], low[3], high[3];
  uint32_t checksum;
};
static_assert(sizeof(SavedCalibration) <= TIMING_ADDRESS, "EEPROM records overlap");
uint32_t checksum(const SavedCalibration &v) {
  const uint8_t *p = reinterpret_cast<const uint8_t *>(&v);
  uint32_t h = 2166136261UL;
  for (size_t i = 0; i < offsetof(SavedCalibration, checksum); ++i) h = (h ^ p[i]) * 16777619UL;
  return h;
}
bool validCalibration(const SavedCalibration &v) {
  if (v.magic != 0x48455841 || v.version != 1 || v.checksum != checksum(v)) return false;
  for (int i = 0; i < 3; ++i) {
    if (v.low[i] < HARD_MIN || v.high[i] > HARD_MAX || v.low[i] >= v.center[i] ||
        v.center[i] >= v.high[i] || v.signs[i] < -1 || v.signs[i] > 1 ||
        v.amplitude[i] < 10 || v.center[i] - v.amplitude[i] < v.low[i] ||
        v.center[i] + v.amplitude[i] > v.high[i]) return false;
  }
  return true;
}
SavedCalibration snapshot() {
  SavedCalibration v = {};
  v.magic = 0x48455841; v.version = 1;
  for (int i = 0; i < 3; ++i) {
    v.center[i] = center[i]; v.signs[i] = signs[i]; v.amplitude[i] = amplitude[i];
    v.low[i] = lowLimit[i]; v.high[i] = highLimit[i];
  }
  v.checksum = checksum(v);
  return v;
}
void applyCalibration(const SavedCalibration &v) {
  for (int i = 0; i < 3; ++i) {
    center[i] = v.center[i]; signs[i] = v.signs[i]; amplitude[i] = v.amplitude[i];
    lowLimit[i] = v.low[i]; highLimit[i] = v.high[i];
  }
}
bool saveCalibration(const SavedCalibration &v) {
  if (!validCalibration(v)) return false;
  EEPROM.put(0, v);
  if (!EEPROM.commit()) return false;
  applyCalibration(v);
  return true;
}
Servo servo[3];
bool enabled = false, running = false;
uint32_t phaseAt = 0;
uint32_t phaseStart = 0;
int commanded[3] = {CENTER, CENTER, CENTER};
int phaseOrigin = CENTER;
bool phaseStarted = false;
WiFiServer server(8266);
WiFiClient client;
bool authenticated = false;
uint32_t clientAt = 0;
uint32_t lastCommandAt = 0;
constexpr uint32_t COMMAND_TIMEOUT_MS = 3000;
int lastWiFiStatus = -1;
uint32_t snapshotSequence = 0;
char input[128]; size_t used = 0; bool overflow = false;
int enabledMask() {
  int mask = 0;
  for (int i = 0; i < 3; ++i) if (servo[i].attached()) mask |= 1 << i;
  return mask;
}

void reply(const char *s) { if (authenticated && client.connected()) client.println(s); }
void detachAll() {
  running = false;
  for (int i = 0; i < 3; ++i) {
    if (servo[i].attached()) servo[i].detach();
    digitalWrite(pins[i], LOW);
    pinMode(pins[i], OUTPUT);
  }
  enabled = false;
}
void stopMotion() {
  running = false;
  // Detaching avoids an unexpected jump to center. Support the robot before stop.
  detachAll();
}
void positions(int left, int right, int tilt) {
  const int p[] = {left, right, tilt};
  for (int i = 0; i < 3; ++i)
    servo[i].writeMicroseconds(constrain(p[i], lowLimit[i], highLimit[i]));
}
void status() {
  if (authenticated) client.printf("STATUS enabled=%d enabled_mask=%d running=%d calibrated=%d queued=%d action=%d step=%d phase=%d ip=%s\n",
    enabled, enabledMask(), running, signs[0] && signs[1] && signs[2], actionCount, actionIndex, stepIndex, phase,
    WiFi.localIP().toString().c_str());
}
bool parseEnd(const char *s) { while (*s == ' ') ++s; return *s == '\0'; }
void handle(char *cmd) {
  lastCommandAt = millis();
  if (!strcmp(cmd, "PING")) { reply("OK PING"); return; }
  if (!strcmp(cmd, "STATUS")) { status(); return; }
  // One cooperative-loop response captures a coherent command state. These are
  // commanded pulses, not measured shaft positions or measured robot travel.
  if (!strcmp(cmd, "SNAPSHOT")) {
    const uint32_t uptime = millis();
    client.printf("SNAPSHOT seq=%lu uptime_ms=%lu phase=%d action=%d step=%d running=%d enabled=%d enabled_mask=%d calibrated=%d queued=%d commanded=%d,%d,%d\n",
      (unsigned long)++snapshotSequence, (unsigned long)uptime, phase,
      actionIndex, stepIndex, running, enabled, enabledMask(),
      signs[0] && signs[1] && signs[2], actionCount,
      commanded[0], commanded[1], commanded[2]);
    return;
  }
  if (!strcmp(cmd, "DIAG")) {
    client.printf("DIAG uptime_ms=%lu wifi=%d rssi=%d heap=%u reset=%s commanded=%d,%d,%d library_us=%d,%d,%d enabled_mask=%d\n",
      (unsigned long)millis(), (int)WiFi.status(), WiFi.RSSI(), ESP.getFreeHeap(),
      ESP.getResetReason().c_str(), commanded[0], commanded[1], commanded[2],
      servo[0].readMicroseconds(), servo[1].readMicroseconds(), servo[2].readMicroseconds(), enabledMask());
    return;
  }
  if (!strcmp(cmd, "CONFIG")) {
    for (int i = 0; i < 3; ++i)
      client.printf("CONFIG joint=%d center=%d min=%d max=%d sign=%d amplitude=%d\n", i + 1, center[i], lowLimit[i], highLimit[i], signs[i], amplitude[i]);
    reply("OK CONFIG"); return;
  }
  if (!strcmp(cmd, "STOP")) { stopMotion(); reply("OK STOP"); return; }
  if (!strcmp(cmd, "TIMING")) {
    client.printf("TIMING move_ms=%lu settle_ms=%lu\n", (unsigned long)moveMs, (unsigned long)settleMs);
    return;
  }
  if (!strcmp(cmd, "CLEAR")) {
    if (running) { reply("ERR busy"); return; }
    actionCount = 0; reply("OK CLEAR"); return;
  }
  if (!strcmp(cmd, "ENABLE ALL")) {
    if (enabled || running) { reply("ERR busy"); return; }
    for (int i = 0; i < 3; ++i) { servo[i].attach(pins[i], lowLimit[i], highLimit[i], center[i]); commanded[i] = center[i]; }
    enabled = true; reply("OK ENABLE ALL"); return;
  }
  int joint, value, c, direction, range, left, right, steps, speed, n = 0;
  int minimum, maximum;
  if (sscanf(cmd, "TIMING %d %d %n", &minimum, &maximum, &n) == 2 && parseEnd(cmd + n)) {
    if (enabled || running) { reply("ERR disable_first"); return; }
    if (minimum < 20 || minimum > 60000 || maximum < 0 || maximum > 60000) { reply("ERR timing"); return; }
    SavedTiming v = {0x54494D45, (uint32_t)minimum, (uint32_t)maximum, 0};
    v.check = v.magic ^ v.move ^ v.settle ^ 0x9537AC12;
    EEPROM.put(TIMING_ADDRESS, v);
    if (!EEPROM.commit()) { reply("ERR storage"); return; }
    moveMs = v.move; settleMs = v.settle;
    reply("OK TIMING"); return;
  }
  if (sscanf(cmd, "ENABLE %d %n", &joint, &n) == 1 && parseEnd(cmd + n)) {
    if (running || joint < 1 || joint > 3 || servo[joint - 1].attached()) { reply("ERR enable"); return; }
    const int i = joint - 1;
    servo[i].attach(pins[i], lowLimit[i], highLimit[i], center[i]);
    commanded[i] = center[i];
    enabled = true;
    client.printf("OK ENABLE %d\n", joint);
    return;
  }
  if (sscanf(cmd, "DISABLE %d %n", &joint, &n) == 1 && parseEnd(cmd + n)) {
    if (running || joint < 1 || joint > 3 || !servo[joint - 1].attached()) { reply("ERR disable"); return; }
    servo[joint - 1].detach();
    digitalWrite(pins[joint - 1], LOW);
    pinMode(pins[joint - 1], OUTPUT);
    enabled = enabledMask() != 0;
    client.printf("OK DISABLE %d\n", joint);
    return;
  }
  if (sscanf(cmd, "TRIM %d %d %n", &joint, &value, &n) == 2 && parseEnd(cmd + n)) {
    if (enabled || running) { reply("ERR disable_first"); return; }
    if (joint < 1 || joint > 3 || value < HARD_MIN || value > HARD_MAX) { reply("ERR trim"); return; }
    SavedCalibration v = snapshot();
    v.center[joint - 1] = value;
    v.checksum = checksum(v);
    if (!saveCalibration(v)) { reply("ERR trim_or_storage"); return; }
    reply("OK TRIM"); return;
  }
  if (sscanf(cmd, "LIMIT %d %d %d %n", &joint, &minimum, &maximum, &n) == 3 && parseEnd(cmd + n)) {
    if (enabled || running) { reply("ERR disable_first"); return; }
    if (joint < 1 || joint > 3) { reply("ERR limits"); return; }
    SavedCalibration v = snapshot();
    v.low[joint - 1] = minimum; v.high[joint - 1] = maximum; v.checksum = checksum(v);
    if (!saveCalibration(v)) { reply("ERR limits_or_storage"); return; }
    reply("OK LIMIT"); return;
  }
  if (sscanf(cmd, "JOG %d %d %n", &joint, &value, &n) == 2 && parseEnd(cmd + n)) {
    if (!enabled || running || joint < 1 || joint > 3 || !servo[joint - 1].attached()) { reply("ERR jog"); return; }
    if (value < -1200 || value > 1200) { reply("ERR jog_limit"); return; }
    int target = center[joint - 1] + value;
    if (target < lowLimit[joint - 1] || target > highLimit[joint - 1]) { reply("ERR jog_limit"); return; }
    servo[joint - 1].writeMicroseconds(target);
    commanded[joint - 1] = target;
    if (servo[joint - 1].readMicroseconds() != target) {
      stopMotion(); reply("ERR library_clamp"); return;
    }
    reply("OK JOG"); return;
  }
  if (sscanf(cmd, "CAL %d %d %d %d %n", &joint, &c, &direction, &range, &n) == 4 && parseEnd(cmd + n)) {
    if (running || joint < 1 || joint > 3 || c < HARD_MIN || c > HARD_MAX ||
        (direction != -1 && direction != 1) || range < 10 || range > 600 ||
        c - range < lowLimit[joint - 1] || c + range > highLimit[joint - 1]) { reply("ERR calibration"); return; }
    // Calibration must be performed with outputs detached: no surprise movement.
    if (enabled) { reply("ERR disable_first"); return; }
    SavedCalibration v = snapshot();
    v.center[joint - 1] = c; v.signs[joint - 1] = direction; v.amplitude[joint - 1] = range;
    v.checksum = checksum(v);
    if (!saveCalibration(v)) { reply("ERR storage"); return; }
    reply("OK CAL"); return;
  }
  if (sscanf(cmd, "ADD %d %d %d %d %n", &left, &right, &steps, &speed, &n) == 4 && parseEnd(cmd + n)) {
    int totalSteps = steps;
    for (int i = 0; i < actionCount; ++i) totalSteps += actions[i].steps;
    if (running || actionCount >= MAX_ACTIONS || left < -100 || left > 100 || right < -100 || right > 100 ||
        (!left && !right) || steps < 1 || steps > 20 || totalSteps > 30 || speed < 1 || speed > 100) { reply("ERR action"); return; }
    actions[actionCount++] = {left, right, steps, speed}; reply("OK ADD"); return;
  }
  if (!strcmp(cmd, "RUN")) {
    if (enabledMask() != 7 || running || !actionCount || !signs[0] || !signs[1] || !signs[2]) { reply("ERR not_ready"); return; }
    // Only the observed forward sequence is available until other gaits are tested.
    for (int i = 0; i < actionCount; ++i) if (actions[i].left != 100 || actions[i].right != 100) { reply("ERR gait_unverified"); return; }
    actionIndex = stepIndex = phase = 0; phaseAt = millis() - 20;
    phaseStarted = false;
    running = true; reply("OK RUN"); return;
  }
  reply("ERR command");
}
void serviceMotion() {
  if (!running) return;
  Action &a = actions[actionIndex];
  // The eight phases were checked individually on the assembled robot.
  // Wi-Fi timing settings define speed=100; lower speed stretches movement only.
  uint32_t slowMs = max(moveMs, (uint32_t)8000);
  uint32_t period = moveMs + (100 - a.speed) * (slowMs - moveMs) / 99;
  if (millis() - phaseAt < 20) return;
  phaseAt = millis();
  const int joints[8] = {2, 1, 2, 0, 2, 0, 2, 1};
  int i = joints[phase];
  const int targets[8] = {min(center[2] + 140, highLimit[2]), highLimit[1], center[2], highLimit[0],
                         max(center[2] - 160, lowLimit[2]), lowLimit[0], center[2], lowLimit[1]};
  if (!phaseStarted) { phaseStart = phaseAt; phaseOrigin = commanded[i]; phaseStarted = true; }
  uint32_t phaseElapsed = phaseAt - phaseStart;
  uint32_t elapsed = phaseElapsed;
  if (elapsed > period) elapsed = period;
  int target = phaseOrigin + (int)((int64_t)(targets[phase] - phaseOrigin) * elapsed / period);
  target = constrain(target, lowLimit[i], highLimit[i]);
  servo[i].writeMicroseconds(target);
  commanded[i] = target;
  if (phaseElapsed >= period + settleMs) {
    phaseStarted = false;
    if (++phase == 8) {
      phase = 0;
      if (++stepIndex >= a.steps) {
        stepIndex = 0;
        if (++actionIndex >= actionCount) { stopMotion(); reply("DONE"); }
      }
    }
  }
}
void serviceNetwork() {
  if (enabled && millis() - lastCommandAt > COMMAND_TIMEOUT_MS) {
    stopMotion();
    Serial.println("STOP: command heartbeat expired");
  }
  int wifiStatus = (int)WiFi.status();
  if (wifiStatus != lastWiFiStatus) {
    Serial.printf("WiFi status=%d ip=%s uptime_ms=%lu\n", wifiStatus,
      WiFi.localIP().toString().c_str(), (unsigned long)millis());
    lastWiFiStatus = wifiStatus;
  }
  // Never continue applying servo force after the station loses Wi-Fi.
  if (wifiStatus != WL_CONNECTED && enabled) {
    stopMotion();
    Serial.println("STOP: WiFi disconnected");
  }
  if (authenticated && !client.connected()) { client.stop(); authenticated = false; }
  if (server.hasClient()) {
    WiFiClient incoming = server.accept();
    if (client.connected()) incoming.stop();
    else { client = incoming; client.setNoDelay(true); authenticated = false; used = 0; overflow = false; clientAt = millis(); }
  }
  if (client.connected() && !authenticated && millis() - clientAt > 5000) client.stop();
  for (int n = 0; n < 64 && client.connected() && client.available(); ++n) {
    char ch = client.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (!overflow && used) {
        input[used] = '\0';
        if (!authenticated) {
          if (!strncmp(input, "AUTH ", 5) && !strcmp(input + 5, BENCH_TOKEN)) { authenticated = true; reply("OK AUTH"); }
          else { client.println("ERR AUTH"); client.stop(); }
        } else handle(input);
      }
      used = 0; overflow = false;
    } else if (!overflow) {
      if (used < sizeof(input) - 1 && ch >= 32 && ch <= 126) input[used++] = ch;
      else { overflow = true; if (running) stopMotion(); }
    }
  }
}
void setup() {
  Serial.begin(115200);
  Serial.printf("BOOT reset=%s\n", ESP.getResetReason().c_str());
  // Avoid floating signal lines while powered servos await an explicit enable.
  for (int i = 0; i < 3; ++i) {
    digitalWrite(pins[i], LOW);
    pinMode(pins[i], OUTPUT);
  }
  EEPROM.begin(128);
  SavedCalibration saved;
  EEPROM.get(0, saved);
  if (validCalibration(saved)) applyCalibration(saved);
  SavedTiming timing;
  EEPROM.get(TIMING_ADDRESS, timing);
  if (validTiming(timing)) { moveMs = timing.move; settleMs = timing.settle; }
  WiFi.persistent(false); WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  WiFi.begin(BENCH_SSID, BENCH_PASSWORD); server.begin(); server.setNoDelay(true);
  Serial.println("HEXAPOD ready; outputs detached; calibration required");
}
void loop() { serviceMotion(); serviceNetwork(); delay(1); }
