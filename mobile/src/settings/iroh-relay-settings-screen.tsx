import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ChevronRight, Globe } from 'lucide-react-native'
import {
  getIrohRelayPreset,
  IROH_RELAY_PRESETS,
  parseIrohRelayUrl,
  type IrohRelayPresetId
} from '../../../src/shared/iroh-relay-preference'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import { IROH_HOME_RELAY_URL_KEY, subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { loadIrohHomeRelayUrl, saveIrohHomeRelayUrl } from '../storage/preferences'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { MobileSettingsFrame } from './mobile-settings-menu'

type RelayChoice = IrohRelayPresetId | 'custom'

const RELAY_LABELS: Record<RelayChoice, string> = {
  automatic: 'Automatic (N0)',
  europe: 'Europe',
  'us-east': 'US-East',
  'us-west': 'US-West',
  asia: 'Asia / Singapore',
  custom: 'Custom HTTPS'
}
const RELAY_OPTIONS: PickerOption<RelayChoice>[] = [
  ...IROH_RELAY_PRESETS.map(({ id, relayUrl }) => ({
    value: id,
    label: RELAY_LABELS[id],
    subtitle: relayUrl ?? 'Use the default N0 relays.'
  })),
  { value: 'custom', label: RELAY_LABELS.custom, subtitle: 'Enter a single HTTPS relay origin.' }
]
const INVALID_CUSTOM_RELAY =
  'Enter a single HTTPS relay origin without credentials, paths, queries, or fragments.'

export default function IrohRelaySettingsScreen({ onBack }: { onBack?: () => void }) {
  const [selected, setSelected] = useState<RelayChoice>('automatic')
  const [customUrl, setCustomUrl] = useState('')
  const [relayUrl, setRelayUrl] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const savedUrl = useRef<string | null>(null)
  const revision = useRef(0)
  const active = useRef(false)
  const savingRef = useRef(false)

  const acceptSavedRelay = useCallback((url: string | null) => {
    revision.current += 1
    savedUrl.current = url
    setRelayUrl(url)
    setSelected(getIrohRelayPreset(url))
    setCustomUrl(url ?? '')
    setLoaded(true)
    setLoading(false)
    setError(null)
  }, [])

  useEffect(() => {
    active.current = true
    let current = true
    const startedAt = revision.current
    setLoading(true)
    const unsubscribe = subscribeMirroredKey(IROH_HOME_RELAY_URL_KEY, (raw) => {
      let url: string | null
      try {
        url = parseIrohRelayUrl(raw)
      } catch {
        url = null
      }
      acceptSavedRelay(url)
    })
    void loadIrohHomeRelayUrl().then(
      (url) => {
        if (current && revision.current === startedAt) {
          acceptSavedRelay(url)
        }
      },
      () => {
        if (current && revision.current === startedAt) {
          setLoading(false)
          setError('Could not load the phone relay preference. Try again.')
        }
      }
    )
    return () => {
      current = false
      active.current = false
      unsubscribe()
    }
  }, [acceptSavedRelay, loadAttempt])

  const saveRelay = async (url: string | null) => {
    if (!loaded || savingRef.current) {
      return
    }
    savingRef.current = true
    const startedAt = revision.current
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      await saveIrohHomeRelayUrl(url)
      if (active.current) {
        // The mirrored notification may already have delivered this or a newer committed choice.
        if (revision.current === startedAt) {
          acceptSavedRelay(url)
        }
        setStatus('Saved. Iroh connections will reconnect using this phone preference.')
      }
    } catch {
      if (active.current) {
        setSelected(getIrohRelayPreset(savedUrl.current))
        setCustomUrl(savedUrl.current ?? '')
        setError(
          'Could not save the phone relay preference. The previous selection is still active.'
        )
      }
    } finally {
      savingRef.current = false
      if (active.current) {
        setSaving(false)
      }
    }
  }
  const disabled = !loaded || saving
  const statusText = loading
    ? 'Loading phone relay preference...'
    : saving
      ? 'Saving phone relay preference...'
      : (status ??
        (loaded ? 'Phone relay preference loaded.' : 'Phone relay preference unavailable.'))

  return (
    <>
      <MobileSettingsFrame title="Iroh relay" onBack={onBack}>
        <Text style={styles.description}>
          Home relay for this phone, used by all Iroh connections. This does not change your
          desktop's relay or its saved pairing hint. Direct and LAN connections remain enabled. You
          can change this setting while offline or if a relay is unavailable.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Phone Iroh home relay"
          accessibilityValue={{ text: loaded ? RELAY_LABELS[selected] : 'Not loaded' }}
          accessibilityState={{ disabled, busy: loading || saving }}
          disabled={disabled}
          onPress={() => setPickerOpen(true)}
          style={({ pressed }) => [
            styles.row,
            pressed && styles.pressed,
            disabled && styles.disabled
          ]}
        >
          <Globe size={16} color={colors.textSecondary} />
          <View style={styles.rowContent}>
            <Text style={styles.label}>Phone home relay</Text>
            <Text style={styles.description}>
              {loaded ? RELAY_LABELS[selected] : 'Loading preference'}
            </Text>
          </View>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        {selected === 'custom' && (
          <View style={styles.customForm}>
            <Text style={styles.label}>Custom HTTPS relay</Text>
            <TextInput
              accessibilityLabel="Custom Iroh relay URL"
              accessibilityHint="Enter an HTTPS origin, then use Save relay to apply it."
              accessibilityState={{ disabled }}
              editable={!disabled}
              style={styles.input}
              value={customUrl}
              onChangeText={(value) => {
                setCustomUrl(value)
                setError(null)
                setStatus(null)
              }}
              placeholder="https://relay.example.com/"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="url"
              returnKeyType="done"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save relay"
              accessibilityState={{ disabled: disabled || !customUrl.trim(), busy: saving }}
              disabled={disabled || !customUrl.trim()}
              style={[styles.button, (disabled || !customUrl.trim()) && styles.disabled]}
              onPress={() => {
                if (disabled || !customUrl.trim()) {
                  return
                }
                let url: string | null
                try {
                  url = parseIrohRelayUrl(customUrl)
                } catch {
                  setError(INVALID_CUSTOM_RELAY)
                  return
                }
                if (url === null) {
                  setError(INVALID_CUSTOM_RELAY)
                  return
                }
                void saveRelay(url)
              }}
            >
              <Text style={styles.label}>Save relay</Text>
            </Pressable>
            <Text style={styles.description}>Draft changes are not applied until you save.</Text>
          </View>
        )}
        {loaded && (
          <Text style={styles.description}>
            Saved home relay: {relayUrl ?? RELAY_LABELS.automatic}
          </Text>
        )}
        <Text
          accessibilityLabel="Iroh relay status"
          accessibilityValue={{ text: statusText }}
          accessibilityLiveRegion="polite"
          style={styles.description}
        >
          {statusText}
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {!loading && !loaded && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading relay preference"
            style={styles.button}
            onPress={() => {
              setError(null)
              setLoadAttempt((attempt) => attempt + 1)
            }}
          >
            <Text style={styles.label}>Try again</Text>
          </Pressable>
        )}
      </MobileSettingsFrame>
      <PickerModal<RelayChoice>
        visible={pickerOpen}
        title="Phone Iroh home relay"
        options={RELAY_OPTIONS}
        selected={selected}
        onSelect={(choice) => {
          if (disabled) {
            return
          }
          setError(null)
          setStatus(null)
          if (choice === 'custom') {
            setSelected('custom')
            setCustomUrl(savedUrl.current ?? '')
          } else {
            const preset = IROH_RELAY_PRESETS.find(({ id }) => id === choice)!
            void saveRelay(preset.relayUrl)
          }
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  description: { color: colors.textSecondary, fontSize: typography.bodySize - 1, lineHeight: 20 },
  label: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '500' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    padding: spacing.md,
    marginVertical: spacing.md
  },
  rowContent: { flex: 1 },
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.5 },
  customForm: { gap: spacing.sm, marginBottom: spacing.md },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    padding: spacing.md,
    fontSize: typography.bodySize
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  error: { color: colors.statusRed, fontSize: typography.bodySize - 1, marginVertical: spacing.sm }
})
