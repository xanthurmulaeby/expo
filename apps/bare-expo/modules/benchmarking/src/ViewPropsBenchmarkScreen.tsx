import { useTheme } from 'ThemeProvider';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import BenchmarkView from './BenchmarkView';
import BenchmarkingModule, { type ViewPropsBenchmark } from './BenchmarkingExpoModule';

// How many prop-update passes to run in a measured batch (after warmup).
const ITERATIONS = 2000;
// Discarded warmup passes so component registration / first-allocation costs don't pollute
// the measured window.
const WARMUP = 200;

type BenchMode = 'all' | 'single';

const ALL_PROP_KEYS = [
  'color',
  'decoration',
  'values',
  'flag',
  'count',
  'ratio',
  'title',
  'subtitle',
] as const;

function valueForKey(key: (typeof ALL_PROP_KEYS)[number], i: number) {
  switch (key) {
    case 'color':
      return i % 2 === 0 ? '#ff0000' : '#00ff00';
    case 'decoration':
      return { opacity: (i % 100) / 100, cornerRadius: i % 24, label: `label-${i}`, weight: i % 7 };
    case 'values':
      return [i, i + 1, i + 2, i + 3, i + 4];
    case 'flag':
      return i % 2 === 0;
    case 'count':
      return i;
    case 'ratio':
      return (i % 50) / 50;
    case 'title':
      return `title-${i}`;
    case 'subtitle':
      return `subtitle-${i}`;
  }
}

/**
 * Builds prop values for pass `i`.
 *
 * - `'all'`: every prop changes each pass — worst case, measures a full re-decode.
 * - `'single'`: only ONE prop changes each pass (cycling which one), the rest keep a value
 *   pinned to a constant. This mirrors a realistic update where Fabric's rawProps diff carries
 *   a single changed prop, so the decode/apply path should touch ~1 prop instead of all of them.
 *   It's the realistic-case counterpart to the synthetic worst case.
 */
// Stable references for the "single" mode's unchanged props.
const PINNED_BASE = Object.fromEntries(ALL_PROP_KEYS.map((k) => [k, valueForKey(k, 0)]));

function propsForPass(i: number, mode: BenchMode) {
  if (mode === 'all') {
    return Object.fromEntries(ALL_PROP_KEYS.map((k) => [k, valueForKey(k, i)]));
  }
  // single: pin every prop to a STABLE pass-0 value, then vary exactly one (chosen by `i`).
  // Reuse the same references for the pinned props (PINNED_BASE) so React's reconciler diffs
  // them as unchanged — otherwise fresh object/array literals (decoration, values) would look
  // changed by identity and end up in the rawProps diff, defeating the single-prop scenario.
  const changing = ALL_PROP_KEYS[i % ALL_PROP_KEYS.length];
  return { ...PINNED_BASE, [changing]: valueForKey(changing, i) };
}

type Result = ViewPropsBenchmark & {
  decodeUsPerPass: number;
  applyUsPerPass: number;
};

export default function ViewPropsBenchmarkScreen() {
  const { theme } = useTheme();
  const [pass, setPass] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);
  const [mode, setMode] = React.useState<BenchMode>('all');

  // Drives ITERATIONS+WARMUP passes via rAF, resetting the native counters right after warmup
  // so only the steady-state window is measured. We bump `pass` each frame; the rendered
  // BenchmarkView receives fresh props, which flows through Fabric → cloneProps (decode) →
  // finalizeUpdates (apply).
  const run = React.useCallback((runMode: BenchMode) => {
    setResult(null);
    setMode(runMode);
    setRunning(true);
    let i = 0;

    const tick = () => {
      if (i === WARMUP) {
        BenchmarkingModule.resetViewPropsBenchmark();
      }
      setPass(i);
      i += 1;

      if (i <= WARMUP + ITERATIONS) {
        requestAnimationFrame(tick);
      } else {
        // Let the last commit flush before reading.
        requestAnimationFrame(() => {
          const snap = BenchmarkingModule.getViewPropsBenchmark();
          // Normalize each side by its OWN pass count: Fabric may call cloneProps (decode)
          // more than once per visual update, while apply runs once per finalizeUpdates.
          const decodePasses = Math.max(snap.decodePassCount, 1);
          const applyPasses = Math.max(snap.applyPassCount, 1);
          const measured: Result = {
            ...snap,
            decodeUsPerPass: (snap.decodeMs * 1000) / decodePasses,
            applyUsPerPass: (snap.applyMs * 1000) / applyPasses,
          };
          console.log('[view-props-benchmark]', {
            mode: runMode,
            iterations: ITERATIONS,
            warmup: WARMUP,
            decodeMs: Number(measured.decodeMs.toFixed(2)),
            applyMs: Number(measured.applyMs.toFixed(2)),
            decodeUsPerPass: Number(measured.decodeUsPerPass.toFixed(2)),
            applyUsPerPass: Number(measured.applyUsPerPass.toFixed(2)),
            decodedPropCount: measured.decodedPropCount,
            legacyPropCount: measured.legacyPropCount,
            decodePassCount: measured.decodePassCount,
            applyPassCount: measured.applyPassCount,
          });
          setResult(measured);
          setRunning(false);
        });
      }
    };
    requestAnimationFrame(tick);
  }, []);

  const props = propsForPass(pass, mode);

  const flagOn = (result?.decodePassCount ?? 0) > 0;
  const cardStyle = {
    backgroundColor: theme.background.element,
    borderColor: theme.border.default,
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.background.screen }}
      contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={[styles.heading, { color: theme.text.default }]}>View-props decoding</Text>
        <Text style={[styles.subheading, { color: theme.text.secondary }]}>
          {ITERATIONS.toLocaleString()} passes · {WARMUP} warmup
        </Text>
      </View>

      <Text style={[styles.note, { color: theme.text.secondary }]}>
        Build with <Text style={styles.code}>EXPO_JSI_VIEW_PROPS=1</Text> then{' '}
        <Text style={styles.code}>=0</Text> and compare. Flag off → all cost lands in apply
        (main thread). "All props" changes every prop each pass (worst case); "1 prop" changes
        one per pass (realistic update).
      </Text>

      <View style={[styles.card, cardStyle, styles.previewCard]}>
        <BenchmarkView style={styles.benchView} {...props} />
      </View>

      <View style={styles.buttonRow}>
        <RunButton label="All props" running={running} onPress={() => run('all')} />
        <RunButton label="1 prop" running={running} onPress={() => run('single')} />
      </View>

      {result ? (
        <View style={[styles.card, cardStyle]}>
          <View style={styles.resultHeader}>
            <Text style={[styles.resultTitle, { color: theme.text.default }]}>
              {mode === 'all' ? 'All props' : '1 prop'} · {ITERATIONS.toLocaleString()} passes
            </Text>
            <View
              style={[
                styles.badge,
                { backgroundColor: theme.background.subtle, borderColor: theme.border.secondary },
              ]}>
              <Text
                style={[
                  styles.badgeText,
                  { color: flagOn ? theme.text.success : theme.text.quaternary },
                ]}>
                {flagOn ? 'JSI · flag on' : 'legacy · flag off'}
              </Text>
            </View>
          </View>

          <Section title="JS thread" theme={theme}>
            <Row label="decode total" value={`${result.decodeMs.toFixed(1)} ms`} theme={theme} />
            <Row
              label="decode / pass"
              value={`${result.decodeUsPerPass.toFixed(1)} µs`}
              theme={theme}
              emphasize
            />
          </Section>

          <Section title="Main thread" theme={theme}>
            <Row label="apply total" value={`${result.applyMs.toFixed(1)} ms`} theme={theme} />
            <Row
              label="apply / pass"
              value={`${result.applyUsPerPass.toFixed(1)} µs`}
              theme={theme}
              emphasize
            />
          </Section>

          <Section title="Counts" theme={theme} last>
            <Row label="decoded props" value={`${result.decodedPropCount}`} theme={theme} />
            <Row label="legacy props" value={`${result.legacyPropCount}`} theme={theme} />
            <Row
              label="decode / apply passes"
              value={`${result.decodePassCount} / ${result.applyPassCount}`}
              theme={theme}
            />
          </Section>
        </View>
      ) : null}
    </ScrollView>
  );
}

function RunButton({
  label,
  running,
  onPress,
}: {
  label: string;
  running: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={running}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: theme.background.element,
          borderColor: theme.border.default,
          opacity: running ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}>
      <Text style={[styles.buttonText, { color: theme.text.link }]}>
        {running ? 'Running…' : label}
      </Text>
    </Pressable>
  );
}

function Section({
  title,
  theme,
  last,
  children,
}: {
  title: string;
  theme: ReturnType<typeof useTheme>['theme'];
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.section, !last && { borderBottomColor: theme.border.secondary, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[styles.sectionTitle, { color: theme.text.quaternary }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function Row({
  label,
  value,
  theme,
  emphasize,
}: {
  label: string;
  value: string;
  theme: ReturnType<typeof useTheme>['theme'];
  emphasize?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.text.secondary }]}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          { color: emphasize ? theme.text.default : theme.text.secondary },
          emphasize && styles.rowValueEmphasized,
        ]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },

  header: { gap: 2 },
  heading: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subheading: { fontSize: 13, fontVariant: ['tabular-nums'] },

  note: { fontSize: 12, lineHeight: 18 },
  code: {
    fontFamily: 'Courier',
    fontSize: 11,
  },

  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
  },
  previewCard: { height: 72 },
  benchView: { flex: 1 },

  buttonRow: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },

  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  resultTitle: { fontSize: 14, fontWeight: '600' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeText: { fontSize: 11, fontWeight: '600' },

  section: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  sectionTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, marginBottom: 2 },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rowLabel: { fontSize: 13 },
  rowValue: { fontSize: 13, fontVariant: ['tabular-nums'] },
  rowValueEmphasized: { fontSize: 15, fontWeight: '700' },
});
