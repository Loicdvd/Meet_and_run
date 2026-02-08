import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  TouchableOpacity,
  FlatList,
  Share,
  Platform
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import DateTimePicker from '@react-native-community/datetimepicker';
import { loadPlans, savePlans, newPlanId } from './storage/runs';
import { decodePolyline } from './utils/geo';

const GOOGLE_MAPS_API_KEY = 'YOUR_GOOGLE_MAPS_API_KEY';

const INITIAL_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05
};

export default function App() {
  const [region, setRegion] = useState(INITIAL_REGION);
  const [location, setLocation] = useState(null);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [routePoints, setRoutePoints] = useState([]);
  const [routeDistanceKm, setRouteDistanceKm] = useState(0);
  const [title, setTitle] = useState('');
  const [dateTime, setDateTime] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [plans, setPlans] = useState([]);
  const [isRouting, setIsRouting] = useState(false);
  const [routeError, setRouteError] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const current = await Location.getCurrentPositionAsync({});
      if (!mounted) return;
      setLocation(current.coords);
      setRegion((prev) => ({
        ...prev,
        latitude: current.coords.latitude,
        longitude: current.coords.longitude
      }));
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      const stored = await loadPlans();
      setPlans(stored);
    })();
  }, []);

  const distanceKm = useMemo(() => {
    if (routePoints.length < 2) return 0;
    return routeDistanceKm;
  }, [routePoints, routeDistanceKm]);

  const onMapPress = (event) => {
    const coordinate = event.nativeEvent.coordinate;
    setRouteError('');
    if (!startPoint) {
      setStartPoint(coordinate);
      return;
    }
    if (!endPoint) {
      setEndPoint(coordinate);
      return;
    }
    setStartPoint(coordinate);
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
  };

  const useCurrentLocation = () => {
    if (!location) return;
    setStartPoint({ latitude: location.latitude, longitude: location.longitude });
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
  };

  const clearRoute = () => {
    setStartPoint(null);
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
    setRouteError('');
  };

  const persistPlans = async (next) => {
    setPlans(next);
    await savePlans(next);
  };

  const buildRoute = async () => {
    if (!startPoint || !endPoint) return;
    setIsRouting(true);
    setRouteError('');
    try {
      if (GOOGLE_MAPS_API_KEY === 'YOUR_GOOGLE_MAPS_API_KEY') {
        setRouteError('Add your Google Maps API key in app.json.');
        setIsRouting(false);
        return;
      }
      const origin = `${startPoint.latitude},${startPoint.longitude}`;
      const destination = `${endPoint.latitude},${endPoint.longitude}`;
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&mode=walking&key=${GOOGLE_MAPS_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();
      if (!data.routes || data.routes.length === 0) {
        setRouteError('No route found. Try different points.');
        setIsRouting(false);
        return;
      }
      const route = data.routes[0];
      const polyline = route.overview_polyline?.points || '';
      const decoded = decodePolyline(polyline);
      setRoutePoints(decoded);
      const meters = route.legs?.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0) || 0;
      setRouteDistanceKm(Number((meters / 1000).toFixed(2)));
    } catch (err) {
      setRouteError('Route generation failed. Check API key and network.');
    } finally {
      setIsRouting(false);
    }
  };

  const savePlan = async () => {
    if (!title.trim()) return;
    if (routePoints.length < 2) return;
    const plan = {
      id: newPlanId(),
      title: title.trim(),
      dateTime: dateTime.toISOString(),
      distanceKm: Number(distanceKm.toFixed(2)),
      points: routePoints,
      startPoint,
      endPoint,
      joined: false,
      createdAt: new Date().toISOString()
    };
    const next = [plan, ...plans];
    await persistPlans(next);
    setTitle('');
    clearRoute();
  };

  const toggleJoin = async (id) => {
    const next = plans.map((plan) =>
      plan.id === id ? { ...plan, joined: !plan.joined } : plan
    );
    await persistPlans(next);
  };

  const sharePlan = async (plan) => {
    const date = new Date(plan.dateTime).toLocaleString();
    const text = `${plan.title}\nWhen: ${date}\nDistance: ${plan.distanceKm} km\nPoints: ${plan.points.length}\nJoin me on Meet and Run!`;
    await Share.share({ message: text });
  };

  const onDateChange = (event, selected) => {
    setShowPicker(Platform.OS === 'ios');
    if (selected) setDateTime(selected);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.mapWrap}>
        <MapView
          style={styles.map}
          provider="google"
          region={region}
          onPress={onMapPress}
        >
          {startPoint && <Marker coordinate={startPoint} title="Start" />}
          {endPoint && <Marker coordinate={endPoint} title="Finish" />}
          {routePoints.length > 1 && (
            <Polyline coordinates={routePoints} strokeWidth={4} strokeColor="#1f7a8c" />
          )}
        </MapView>
        <View style={styles.mapHint}>
          <Text style={styles.mapHintText}>Tap to set start and finish points</Text>
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.heading}>Plan a Run</Text>
        <TextInput
          style={styles.input}
          placeholder="Run title"
          value={title}
          onChangeText={setTitle}
        />
        <View style={styles.row}>
          <TouchableOpacity style={styles.button} onPress={() => setShowPicker(true)}>
            <Text style={styles.buttonText}>Pick Date & Time</Text>
          </TouchableOpacity>
          <Text style={styles.metaText}>{dateTime.toLocaleString()}</Text>
        </View>
        {showPicker && (
          <DateTimePicker value={dateTime} mode="datetime" onChange={onDateChange} />
        )}

        <View style={styles.row}>
          <TouchableOpacity style={styles.button} onPress={useCurrentLocation}>
            <Text style={styles.buttonText}>Use My Location</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={buildRoute} disabled={isRouting}>
            <Text style={styles.buttonText}>{isRouting ? 'Routing...' : 'Generate Route'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.buttonAlt} onPress={clearRoute}>
            <Text style={styles.buttonAltText}>Clear Route</Text>
          </TouchableOpacity>
        </View>

        {!!routeError && <Text style={styles.errorText}>{routeError}</Text>}
        <Text style={styles.metaText}>Distance: {distanceKm.toFixed(2)} km</Text>

        <TouchableOpacity style={styles.saveButton} onPress={savePlan}>
          <Text style={styles.saveButtonText}>Save Run Plan</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.listWrap}>
        <Text style={styles.heading}>Planned Runs</Text>
        <FlatList
          data={plans}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<Text style={styles.empty}>No plans yet.</Text>}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardMeta}>{new Date(item.dateTime).toLocaleString()}</Text>
              <Text style={styles.cardMeta}>Distance: {item.distanceKm} km</Text>
              <Text style={styles.cardMeta}>Points: {item.points.length}</Text>
              <View style={styles.row}>
                <TouchableOpacity
                  style={item.joined ? styles.joinedButton : styles.joinButton}
                  onPress={() => toggleJoin(item.id)}
                >
                  <Text style={styles.joinText}>{item.joined ? 'Joined' : 'Join'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.shareButton} onPress={() => sharePlan(item)}>
                  <Text style={styles.shareText}>Share</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f6f8f9'
  },
  mapWrap: {
    flex: 1.1
  },
  map: {
    flex: 1
  },
  mapHint: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    padding: 8,
    borderRadius: 8
  },
  mapHintText: {
    color: '#fff',
    textAlign: 'center'
  },
  panel: {
    padding: 16,
    backgroundColor: '#fff'
  },
  heading: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    color: '#143642'
  },
  input: {
    borderWidth: 1,
    borderColor: '#dbe2e8',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10
  },
  button: {
    backgroundColor: '#1f7a8c',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600'
  },
  buttonAlt: {
    backgroundColor: '#dbe2e8',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8
  },
  buttonAltText: {
    color: '#143642'
  },
  metaText: {
    color: '#516a75'
  },
  errorText: {
    color: '#c53030',
    marginBottom: 6
  },
  saveButton: {
    backgroundColor: '#ff7f50',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 6
  },
  saveButtonText: {
    color: '#fff',
    fontWeight: '700'
  },
  listWrap: {
    flex: 1.1,
    padding: 16
  },
  card: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8ec'
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#143642'
  },
  cardMeta: {
    color: '#516a75'
  },
  empty: {
    color: '#8a9ba8'
  },
  joinButton: {
    backgroundColor: '#1f7a8c',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8
  },
  joinedButton: {
    backgroundColor: '#0b4f6c',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8
  },
  joinText: {
    color: '#fff',
    fontWeight: '600'
  },
  shareButton: {
    backgroundColor: '#ffe5d9',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8
  },
  shareText: {
    color: '#c05621',
    fontWeight: '600'
  }
});
