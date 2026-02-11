import { View, Text, StyleSheet } from 'react-native';

export default function BrandMark({ size = 28, compact = false }) {
  const dot = Math.max(6, Math.round(size * 0.24));
  return (
    <View style={styles.row}>
      <View style={[styles.icon, { width: size, height: size, borderRadius: size / 2 }]}> 
        <View style={[styles.path, { width: size * 0.6, height: 2 }]} />
        <View style={[styles.dotStart, { width: dot, height: dot, borderRadius: dot / 2 }]} />
        <View style={[styles.dotEnd, { width: dot, height: dot, borderRadius: dot / 2 }]} />
      </View>
      {!compact && <Text style={styles.wordmark}>StrideLoop</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  icon: {
    backgroundColor: '#0B1B2B',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  path: {
    backgroundColor: '#13B48A',
    transform: [{ rotate: '-28deg' }]
  },
  dotStart: {
    position: 'absolute',
    left: 5,
    bottom: 6,
    backgroundColor: '#13B48A'
  },
  dotEnd: {
    position: 'absolute',
    right: 5,
    top: 6,
    backgroundColor: '#FF7A45'
  },
  wordmark: {
    color: '#0B1B2B',
    fontSize: 18,
    fontWeight: '700'
  }
});
