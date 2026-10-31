// Bandeau d'entrée de chaque onglet : le titre et le chiffre qui compte, en haut, sous l'encoche, à la place de l'en-tête de navigation.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AMBRE } from '../theme';

interface HeroProps {
  title: string;
  caption?: string;
  value?: string;
  tone?: 'amber' | 'good' | 'bad';
  children?: React.ReactNode;
}

export default function Hero({ title, caption, value, tone = 'amber', children }: HeroProps) {
  const insets = useSafeAreaInsets();
  const color = tone === 'good' ? AMBRE.good : tone === 'bad' ? AMBRE.bad : AMBRE.amber;
  return (
    <View style={[styles.band, { paddingTop: insets.top + 14 }]}>
      <View style={styles.row}>
        <View style={styles.left}>
          <Text style={styles.title} numberOfLines={2}>{title}</Text>
          {!!caption && <Text style={styles.caption}>{caption}</Text>}
        </View>
        {!!value && <Text style={[styles.value, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    backgroundColor: AMBRE.band,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    borderBottomWidth: 1,
    borderColor: AMBRE.line,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  left: { flex: 1 },
  title: { color: AMBRE.ink, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  caption: { color: AMBRE.mute, fontSize: 13, marginTop: 4 },
  value: { fontSize: 44, fontWeight: '800', letterSpacing: -1.5, maxWidth: '55%' },
});
