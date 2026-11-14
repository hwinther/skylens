/**
 * Settings → About → "3D models": the credits for the cockpit view's 3D models (src/sim/modelCredits.ts).
 * One compact row ("11 models · CC BY 3.0 / CC0") that unfolds into the list: per model what it stands
 * for, title, author, licence and source (each opens its page), plus the note that they were modified.
 */

import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { MODEL_CHANGES_NOTE, MODEL_CREDITS, modelCreditsSummary } from "@/sim/modelCredits";
import { color } from "@/theme";

export function ModelCredits() {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.root}>
      <Pressable
        testID="settings-model-credits"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        style={styles.head}
        onPress={() => setOpen((o) => !o)}
        hitSlop={6}
      >
        <Text style={styles.label}>3D models</Text>
        <View style={styles.headRight}>
          <Text style={styles.summary}>{modelCreditsSummary()}</Text>
          <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={20} color={color.textDim} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.list} testID="settings-model-credits-list">
          {MODEL_CREDITS.map((c) => (
            <View key={c.cls} style={styles.item} testID={`settings-model-credit-${c.cls}`}>
              <Text style={styles.role}>{c.role}</Text>
              <Text style={styles.line}>
                <Text style={styles.link} onPress={() => void Linking.openURL(c.sourceUrl)}>
                  {c.title}
                </Text>
                {` by ${c.author} · `}
                <Text style={styles.link} onPress={() => void Linking.openURL(c.licenceUrl)}>
                  {c.licence}
                </Text>
                {` · via ${c.via}`}
              </Text>
            </View>
          ))}
          <Text style={styles.note}>{MODEL_CHANGES_NOTE}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headRight: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, marginLeft: 12 },
  label: { color: color.text, fontSize: 15 },
  summary: { color: color.textDim, fontSize: 15, flexShrink: 1, textAlign: "right" },
  list: { gap: 8 },
  item: { gap: 2 },
  role: { color: color.textDim, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  line: { color: color.text, fontSize: 13 },
  link: { color: color.entity.air, textDecorationLine: "underline" },
  note: { color: color.textMuted, fontSize: 12 },
});
