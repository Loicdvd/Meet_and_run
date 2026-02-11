import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
import MapView, { Marker, Polyline } from 'react-native-maps';
import BrandMark from './components/BrandMark';
import { decodePolyline, haversineKm } from './utils/geo';
import { isSupabaseConfigured, supabase } from './services/supabase';

const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY || '';

const INITIAL_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05
};

const TYPEFACE = Platform.select({
  ios: 'AvenirNext-Regular',
  android: 'sans-serif',
  default: 'System'
});

const TYPEFACE_MEDIUM = Platform.select({
  ios: 'AvenirNext-DemiBold',
  android: 'sans-serif-medium',
  default: 'System'
});

function formatWhen(dateIso) {
  return new Date(dateIso).toLocaleString();
}

function formatRunnerId(id) {
  if (!id) return 'Runner';
  return `Runner ${id.slice(0, 6)}`;
}

function runnerInitials(id) {
  if (!id) return 'R';
  return id.slice(0, 2).toUpperCase();
}

function profileDisplayName(id, currentUserId, profilesById, preferYou = true) {
  if (!id) return 'Runner';
  const profile = profilesById?.[id];
  const fullName = (profile?.full_name || '').trim();
  const username = (profile?.username || '').trim();
  const fallback = formatRunnerId(id);
  if (id === currentUserId && preferYou) {
    if (fullName) return `You (${fullName})`;
    if (username) return `You (@${username})`;
    return 'You';
  }
  if (fullName) return fullName;
  if (username) return `@${username}`;
  return fallback;
}

function formatPoint(point) {
  if (!point?.latitude || !point?.longitude) return 'N/A';
  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}

function destinationPoint(start, distanceKm, bearingDeg) {
  const R = 6371;
  const brng = (bearingDeg * Math.PI) / 180;
  const dByR = distanceKm / R;
  const lat1 = (start.latitude * Math.PI) / 180;
  const lon1 = (start.longitude * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) + Math.cos(lat1) * Math.sin(dByR) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dByR) * Math.cos(lat1),
      Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    latitude: (lat2 * 180) / Math.PI,
    longitude: (lon2 * 180) / Math.PI
  };
}

function elevationGainFromValues(values) {
  if (!values || values.length < 2) return 0;
  let gain = 0;
  for (let i = 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gain += diff;
  }
  return gain;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stripHtml(text = '') {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

const PEDESTRIAN_KEYWORDS = [
  'trail',
  'path',
  'footpath',
  'promenade',
  'greenway',
  'park',
  'stairs',
  'walkway',
  'pedestrian'
];

const CAR_ROAD_KEYWORDS = [
  'road',
  'rd',
  'street',
  'st',
  'avenue',
  'ave',
  'boulevard',
  'blvd',
  'highway',
  'hwy',
  'drive',
  'dr',
  'route'
];

function computeRoadExposure(route) {
  let totalMeters = 0;
  let carRoadMeters = 0;
  let pedestrianMeters = 0;

  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const meters = Number(step.distance?.value || 0);
      if (meters <= 0) continue;
      totalMeters += meters;
      const text = stripHtml(`${step.html_instructions || ''} ${step.maneuver || ''}`);
      const isPedestrian = PEDESTRIAN_KEYWORDS.some((k) => text.includes(k));
      const isCarRoad = CAR_ROAD_KEYWORDS.some((k) => text.includes(k));

      if (isPedestrian) pedestrianMeters += meters;
      if (isCarRoad && !isPedestrian) carRoadMeters += meters;
    }
  }

  return {
    totalKm: totalMeters / 1000,
    carRoadKm: carRoadMeters / 1000,
    pedestrianKm: pedestrianMeters / 1000,
    carRoadRatio: totalMeters > 0 ? carRoadMeters / totalMeters : 0
  };
}

function toXYMeters(point, refLat) {
  const R = 6371000;
  const latRad = (point.latitude * Math.PI) / 180;
  const lonRad = (point.longitude * Math.PI) / 180;
  const refLatRad = (refLat * Math.PI) / 180;
  return {
    x: R * lonRad * Math.cos(refLatRad),
    y: R * latRad
  };
}

function distancePointToSegmentMeters(p, a, b) {
  const refLat = p.latitude;
  const P = toXYMeters(p, refLat);
  const A = toXYMeters(a, refLat);
  const B = toXYMeters(b, refLat);
  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;
  const ab2 = ABx * ABx + ABy * ABy;
  if (ab2 === 0) {
    const dx = P.x - A.x;
    const dy = P.y - A.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  let t = (APx * ABx + APy * ABy) / ab2;
  t = Math.max(0, Math.min(1, t));
  const Qx = A.x + ABx * t;
  const Qy = A.y + ABy * t;
  const dx = P.x - Qx;
  const dy = P.y - Qy;
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToPolylineMeters(point, polyline) {
  if (!polyline || polyline.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < polyline.length; i += 1) {
    const d = distancePointToSegmentMeters(point, polyline[i - 1], polyline[i]);
    if (d < best) best = d;
  }
  return best;
}

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function difficultyLabelFromScore(score) {
  if (score < 0.9) return 'Easy';
  if (score < 1.3) return 'Moderate';
  if (score < 1.8) return 'Challenging';
  return 'Hard';
}

function mapPlanRow(row, participantsByRunId, profilesById, currentUserId) {
  const participantInfo = participantsByRunId.get(row.id) || { count: 0, joined: false, ids: [] };
  const isOwner = row.owner_id === currentUserId;
  const participantIds = Array.from(new Set([row.owner_id, ...(participantInfo.ids || [])]));

  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerLabel: profileDisplayName(row.owner_id, currentUserId, profilesById),
    title: row.title,
    dateTime: row.date_time,
    distanceKm: Number(row.distance_km || 0),
    points: row.points || [],
    startPoint: row.start_point || null,
    endPoint: row.end_point || null,
    createdAt: row.created_at,
    joined: isOwner ? true : participantInfo.joined,
    participantCount: isOwner ? participantInfo.count + 1 : participantInfo.count,
    participantIds
  };
}

function AuthGate({
  mode,
  onModeChange,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  onSubmit,
  isSubmitting,
  authError
}) {
  return (
    <SafeAreaView style={styles.authWrap}>
      <View style={styles.authCard}>
        <BrandMark size={34} />
        <Text style={styles.authTitle}>StrideLoop</Text>
        <Text style={styles.authSubtitle}>Sign in to create and join runs across devices.</Text>

        <View style={styles.authToggleRow}>
          <Pressable
            style={[styles.authToggle, mode === 'signin' && styles.authToggleActive]}
            onPress={() => onModeChange('signin')}
          >
            <Text style={[styles.authToggleText, mode === 'signin' && styles.authToggleTextActive]}>
              Sign In
            </Text>
          </Pressable>
          <Pressable
            style={[styles.authToggle, mode === 'signup' && styles.authToggleActive]}
            onPress={() => onModeChange('signup')}
          >
            <Text style={[styles.authToggleText, mode === 'signup' && styles.authToggleTextActive]}>
              Sign Up
            </Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.authInput}
          placeholder="Email"
          placeholderTextColor="#7d8c95"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={onEmailChange}
        />

        <TextInput
          style={styles.authInput}
          placeholder="Password"
          placeholderTextColor="#7d8c95"
          secureTextEntry
          value={password}
          onChangeText={onPasswordChange}
        />

        {!!authError && <Text style={styles.errorText}>{authError}</Text>}

        <Pressable style={styles.authSubmit} onPress={onSubmit} disabled={isSubmitting}>
          {isSubmitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.authSubmitText}>{mode === 'signin' ? 'Sign In' : 'Create Account'}</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function MissingConfig() {
  return (
    <SafeAreaView style={styles.authWrap}>
      <View style={styles.authCard}>
        <BrandMark size={34} />
        <Text style={styles.authTitle}>StrideLoop</Text>
        <Text style={styles.authSubtitle}>Supabase is not configured yet.</Text>
        <Text style={styles.authSubtitle}>Add these variables to `.env` then restart Expo:</Text>
        <Text style={styles.configVar}>EXPO_PUBLIC_SUPABASE_URL=...</Text>
        <Text style={styles.configVar}>EXPO_PUBLIC_SUPABASE_ANON_KEY=...</Text>
        <Text style={styles.configVar}>EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY=...</Text>
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const mapRef = useRef(null);
  const plannerPagerRef = useRef(null);
  const suggestionTimerRef = useRef(null);
  const runWatchRef = useRef(null);
  const runTimerRef = useRef(null);
  const maxOffRouteRef = useRef(0);
  const routePreviewReqRef = useRef(0);
  const windowHeight = Dimensions.get('window').height;
  const windowWidth = Dimensions.get('window').width;
  const panelMinHeight = 72;
  const panelMaxHeight = Math.min(560, Math.max(340, Math.round(windowHeight * 0.62)));
  const panelHalfHeight = Math.round(panelMinHeight + (panelMaxHeight - panelMinHeight) * 0.55);
  const panelPageWidth = windowWidth - 32;
  const panelHeight = useRef(new Animated.Value(panelMaxHeight)).current;
  const panelDragStartRef = useRef(panelMaxHeight);

  const [session, setSession] = useState(null);
  const [isAuthBooting, setIsAuthBooting] = useState(true);
  const [authMode, setAuthMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('planner');
  const [plannerPage, setPlannerPage] = useState(0);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isCreationCollapsed, setIsCreationCollapsed] = useState(false);
  const [panelSnap, setPanelSnap] = useState('full');
  const [runFeedMode, setRunFeedMode] = useState('following');
  const [followSearchQuery, setFollowSearchQuery] = useState('');
  const [planningMode, setPlanningMode] = useState('manual');
  const [targetDistanceInput, setTargetDistanceInput] = useState('5');
  const [optionAvoidCars, setOptionAvoidCars] = useState(true);
  const [optionPreferHighElevation, setOptionPreferHighElevation] = useState(false);
  const [showRouteOptions, setShowRouteOptions] = useState(false);
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeSearchError, setPlaceSearchError] = useState('');
  const [placeSuggestions, setPlaceSuggestions] = useState([]);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState([]);

  const [region, setRegion] = useState(INITIAL_REGION);
  const [location, setLocation] = useState(null);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [routePoints, setRoutePoints] = useState([]);
  const [routeDistanceKm, setRouteDistanceKm] = useState(0);
  const [title, setTitle] = useState('');
  const [dateTime, setDateTime] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState('date');
  const [plans, setPlans] = useState([]);
  const [followedOwnerIds, setFollowedOwnerIds] = useState(new Set());
  const [plansError, setPlansError] = useState('');
  const [plansLoading, setPlansLoading] = useState(false);
  const [isRouting, setIsRouting] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [sortMode, setSortMode] = useState('date');
  const [isRunActive, setIsRunActive] = useState(false);
  const [runTrack, setRunTrack] = useState([]);
  const [runDistanceKm, setRunDistanceKm] = useState(0);
  const [runElapsedSec, setRunElapsedSec] = useState(0);
  const [offRouteMeters, setOffRouteMeters] = useState(0);
  const [runSessions, setRunSessions] = useState([]);
  const [lastRunSummary, setLastRunSummary] = useState(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState(null);
  const [profilesById, setProfilesById] = useState({});
  const [profileUsername, setProfileUsername] = useState('');
  const [profileFullName, setProfileFullName] = useState('');
  const [profileCity, setProfileCity] = useState('');
  const [profileStatus, setProfileStatus] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [pendingRatingSessionId, setPendingRatingSessionId] = useState(null);
  const [ratingEnjoyment, setRatingEnjoyment] = useState(0);
  const [ratingDifficulty, setRatingDifficulty] = useState(0);
  const [routeElevationGainM, setRouteElevationGainM] = useState(0);
  const [routeEstimatedDurationMin, setRouteEstimatedDurationMin] = useState(0);
  const [routeDifficultyLabel, setRouteDifficultyLabel] = useState('Unknown');
  const [isRoutePreviewLoading, setIsRoutePreviewLoading] = useState(false);
  const profileInitializedRef = useRef(false);

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
    if (!isSupabaseConfigured || !supabase) {
      setIsAuthBooting(false);
      return () => {};
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        setAuthError(error.message);
      }
      setSession(data.session ?? null);
      setIsAuthBooting(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user?.id) {
      setShowOnboarding(false);
      return;
    }

    (async () => {
      const key = `run_planner:onboarding_seen:${session.user.id}`;
      const seen = await AsyncStorage.getItem(key);
      setShowOnboarding(!seen);
    })();
  }, [session?.user?.id]);

  const loadRemotePlans = async () => {
    if (!supabase || !session?.user?.id) return;

    setPlansLoading(true);
    setPlansError('');

    try {
      const { data: runRows, error: runsError } = await supabase
        .from('run_plans')
        .select('*')
        .order('date_time', { ascending: true });

      if (runsError) throw runsError;

      const runIds = (runRows || []).map((row) => row.id);
      const profileIds = new Set([session.user.id]);
      const participantsByRunId = new Map();
      let nextFollowedOwnerIds = new Set();

      for (const row of runRows || []) {
        profileIds.add(row.owner_id);
      }

      const { data: followRows, error: followError } = await supabase
        .from('user_follows')
        .select('follows_user_id')
        .eq('user_id', session.user.id);

      if (followError && followError.code !== '42P01') {
        throw followError;
      }
      if (followError?.code === '42P01') {
        setPlansError('Missing "user_follows" table. Run the updated SQL from README.');
      }
      if (followRows) {
        nextFollowedOwnerIds = new Set(followRows.map((row) => row.follows_user_id));
        for (const row of followRows) {
          profileIds.add(row.follows_user_id);
        }
      }

      if (runIds.length > 0) {
        const { data: participantRows, error: participantError } = await supabase
          .from('run_participants')
          .select('run_id,user_id')
          .in('run_id', runIds);

        if (participantError) throw participantError;

        for (const row of participantRows || []) {
          const prev = participantsByRunId.get(row.run_id) || { count: 0, joined: false, ids: [] };
          const next = {
            count: prev.count + 1,
            joined: prev.joined || row.user_id === session.user.id,
            ids: [...prev.ids, row.user_id]
          };
          participantsByRunId.set(row.run_id, next);
          profileIds.add(row.user_id);
        }
      }

      const nextProfilesById = {};
      if (profileIds.size > 0) {
        const { data: profileRows, error: profileError } = await supabase
          .from('profiles')
          .select('id,username,full_name,city')
          .in('id', Array.from(profileIds));
        if (profileError && profileError.code !== '42P01') {
          throw profileError;
        }
        if (profileError?.code === '42P01') {
          setPlansError('Missing "profiles" table. Run the profile SQL setup first.');
        }
        for (const row of profileRows || []) {
          nextProfilesById[row.id] = row;
        }
      }

      const mapped = (runRows || []).map((row) =>
        mapPlanRow(row, participantsByRunId, nextProfilesById, session.user.id)
      );
      setPlans(mapped);
      setFollowedOwnerIds(nextFollowedOwnerIds);
      setProfilesById(nextProfilesById);

      if (!profileInitializedRef.current) {
        const me = nextProfilesById[session.user.id];
        if (me) {
          setProfileUsername(me.username || '');
          setProfileFullName(me.full_name || '');
          setProfileCity(me.city || '');
        }
        profileInitializedRef.current = true;
      }
    } catch (err) {
      setPlansError(err.message || 'Failed to load plans from backend.');
    } finally {
      setPlansLoading(false);
    }
  };

  useEffect(() => {
    if (session?.user?.id) {
      profileInitializedRef.current = false;
      setProfileStatus('');
      void loadRemotePlans();
    } else {
      setPlans([]);
      setFollowedOwnerIds(new Set());
      setProfilesById({});
      setProfileUsername('');
      setProfileFullName('');
      setProfileCity('');
      profileInitializedRef.current = false;
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) {
      setRunSessions([]);
      return;
    }
    (async () => {
      const key = `run_planner:run_sessions:${session.user.id}`;
      const raw = await AsyncStorage.getItem(key);
      if (!raw) {
        setRunSessions([]);
        return;
      }
      try {
        setRunSessions(JSON.parse(raw));
      } catch (_err) {
        setRunSessions([]);
      }
    })();
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) {
      setRecentSearches([]);
      return;
    }
    (async () => {
      const key = `run_planner:recent_searches:${session.user.id}`;
      const raw = await AsyncStorage.getItem(key);
      if (!raw) {
        setRecentSearches([]);
        return;
      }
      try {
        setRecentSearches(JSON.parse(raw));
      } catch (_err) {
        setRecentSearches([]);
      }
    })();
  }, [session?.user?.id]);

  useEffect(() => {
    return () => {
      if (runTimerRef.current) clearInterval(runTimerRef.current);
      if (runWatchRef.current) {
        runWatchRef.current.remove();
      }
      if (suggestionTimerRef.current) {
        clearTimeout(suggestionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (suggestionTimerRef.current) {
      clearTimeout(suggestionTimerRef.current);
    }
    const q = placeQuery.trim();
    if (q.length < 3) {
      setPlaceSuggestions([]);
      return;
    }
    suggestionTimerRef.current = setTimeout(() => {
      void fetchPlaceSuggestions(q);
    }, 260);
    return () => {
      if (suggestionTimerRef.current) {
        clearTimeout(suggestionTimerRef.current);
      }
    };
  }, [placeQuery]);

  useEffect(() => {
    if (routePoints.length < 2 || !mapRef.current) return;
    mapRef.current.fitToCoordinates(routePoints, {
      edgePadding: { top: 80, right: 80, bottom: 80, left: 80 },
      animated: true
    });
  }, [routePoints]);

  useEffect(() => {
    if (!selectedRunDetail) return;
    const updated = plans.find((p) => p.id === selectedRunDetail.id);
    if (!updated) {
      setSelectedRunDetail(null);
      return;
    }
    setSelectedRunDetail(updated);
  }, [plans, selectedRunDetail]);

  const distanceKm = useMemo(() => {
    if (routePoints.length < 2) return 0;
    return routeDistanceKm;
  }, [routePoints, routeDistanceKm]);

  const plannerStep = useMemo(() => {
    if (planningMode === 'auto_loop') {
      if (!startPoint) return 'Loop mode: set a start point on the map';
      if (isRouting) return 'Generating loop route...';
      if (routePoints.length > 1) return 'Loop route ready';
      return 'Set target distance then generate';
    }
    if (!startPoint) return 'Step 1: Tap map to set a start point';
    if (!endPoint) return 'Step 2: Tap map again to set finish';
    if (isRouting) return 'Generating route...';
    if (routePoints.length > 1) return 'Route ready';
    return 'Step 3: Generate route';
  }, [planningMode, startPoint, endPoint, routePoints.length, isRouting]);

  const canGenerate =
    planningMode === 'auto_loop'
      ? !!startPoint && Number(targetDistanceInput) >= 1 && !isRouting
      : !!startPoint && !!endPoint && !isRouting;
  const canSave = !!title.trim() && routePoints.length > 1 && !isRouting;

  const plansWithDistance = useMemo(() => {
    return plans.map((plan) => {
      if (!location || !plan.startPoint) {
        return { ...plan, distanceFromCurrentKm: null };
      }
      const distanceFromCurrentKm = haversineKm(
        {
          latitude: location.latitude,
          longitude: location.longitude
        },
        {
          latitude: plan.startPoint.latitude,
          longitude: plan.startPoint.longitude
        }
      );
      return { ...plan, distanceFromCurrentKm: Number(distanceFromCurrentKm.toFixed(2)) };
    });
  }, [plans, location]);

  const sortedPlans = useMemo(() => {
    const next = [...plansWithDistance];
    if (sortMode === 'distance') {
      next.sort((a, b) => {
        const da = a.distanceFromCurrentKm ?? Number.POSITIVE_INFINITY;
        const db = b.distanceFromCurrentKm ?? Number.POSITIVE_INFINITY;
        return da - db;
      });
      return next;
    }
    next.sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
    return next;
  }, [plansWithDistance, sortMode]);

  const runStats = useMemo(() => {
    const userId = session?.user?.id;
    const created = plans.filter((plan) => plan.ownerId === userId);
    const joined = plans.filter((plan) => plan.ownerId !== userId && plan.joined);
    const totalDistance = created.reduce((sum, plan) => sum + Number(plan.distanceKm || 0), 0);
    return {
      createdCount: created.length,
      joinedCount: joined.length,
      totalDistanceKm: Number(totalDistance.toFixed(1)),
      followingCount: followedOwnerIds.size
    };
  }, [plans, session?.user?.id, followedOwnerIds]);

  const performanceProfile = useMemo(() => {
    if (runSessions.length === 0) {
      return {
        avgPaceMinPerKm: 6.5,
        avgDistanceKm: 5,
        avgDurationMin: 32,
        avgElevationM: 60,
        hasHistory: false
      };
    }
    const samples = runSessions.slice(0, 12);
    const pace = samples.reduce((s, r) => s + Number(r.avgPaceMinPerKm || 0), 0) / samples.length;
    const dist = samples.reduce((s, r) => s + Number(r.distanceKm || 0), 0) / samples.length;
    const dur = samples.reduce((s, r) => s + Number((r.durationSec || 0) / 60), 0) / samples.length;
    const elev = samples.reduce((s, r) => s + Number(r.elevationGainM || 0), 0) / samples.length;
    return {
      avgPaceMinPerKm: Number(pace.toFixed(2)),
      avgDistanceKm: Number(dist.toFixed(2)),
      avgDurationMin: Number(dur.toFixed(1)),
      avgElevationM: Number(elev.toFixed(0)),
      hasHistory: true
    };
  }, [runSessions]);

  const followedRunners = useMemo(() => {
    return Array.from(followedOwnerIds).map((id) => ({
      id,
      label: profileDisplayName(id, session?.user?.id, profilesById, false),
      upcomingRuns: plans.filter((plan) => plan.ownerId === id).length
    }));
  }, [followedOwnerIds, plans, profilesById, session?.user?.id]);

  const panelSnapHeight = (snap) => {
    if (snap === 'collapsed') return panelMinHeight;
    if (snap === 'half') return panelHalfHeight;
    return panelMaxHeight;
  };

  const nearestSnapFromHeight = (value) => {
    const diffs = [
      { snap: 'collapsed', diff: Math.abs(value - panelMinHeight) },
      { snap: 'half', diff: Math.abs(value - panelHalfHeight) },
      { snap: 'full', diff: Math.abs(value - panelMaxHeight) }
    ];
    diffs.sort((a, b) => a.diff - b.diff);
    return diffs[0].snap;
  };

  const animatePanelToSnap = (snap) => {
    setPanelSnap(snap);
    setIsCreationCollapsed(snap === 'collapsed');
    Animated.spring(panelHeight, {
      toValue: panelSnapHeight(snap),
      useNativeDriver: false,
      bounciness: 0,
      speed: 20
    }).start();
  };

  const openPlannerPage = (idx) => {
    setPlannerPage(idx);
    if (plannerPagerRef.current) {
      plannerPagerRef.current.scrollTo({ x: idx * panelPageWidth, animated: true });
    }
    if (panelSnap === 'collapsed') {
      animatePanelToSnap('half');
    }
  };

  const panelPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gestureState) => Math.abs(gestureState.dy) > 6,
        onPanResponderGrant: () => {
          panelHeight.stopAnimation((value) => {
            panelDragStartRef.current = value;
          });
        },
        onPanResponderMove: (_evt, gestureState) => {
          const nextHeight = clamp(
            panelDragStartRef.current - gestureState.dy,
            panelMinHeight,
            panelMaxHeight
          );
          panelHeight.setValue(nextHeight);
        },
        onPanResponderRelease: (_evt, gestureState) => {
          const swipedDown = gestureState.dy > 38 || gestureState.vy > 0.35;
          const swipedUp = gestureState.dy < -38 || gestureState.vy < -0.35;

          panelHeight.stopAnimation((value) => {
            const currentSnap = nearestSnapFromHeight(value);
            if (swipedDown) {
              if (currentSnap === 'full') animatePanelToSnap('half');
              else animatePanelToSnap('collapsed');
              return;
            }
            if (swipedUp) {
              if (currentSnap === 'collapsed') animatePanelToSnap('half');
              else animatePanelToSnap('full');
              return;
            }
            animatePanelToSnap(currentSnap);
          });
        },
        onPanResponderTerminate: () => {
          panelHeight.stopAnimation((value) => {
            animatePanelToSnap(nearestSnapFromHeight(value));
          });
        }
      }),
    [panelHeight, panelMaxHeight, panelMinHeight, panelHalfHeight]
  );

  const searchableOwners = useMemo(() => {
    const ownerMap = new Map();
    for (const plan of plans) {
      if (plan.ownerId === session?.user?.id) continue;
      if (!ownerMap.has(plan.ownerId)) {
        ownerMap.set(plan.ownerId, {
          id: plan.ownerId,
          label: profileDisplayName(plan.ownerId, session?.user?.id, profilesById, false),
          runCount: 0
        });
      }
      ownerMap.get(plan.ownerId).runCount += 1;
    }
    const query = followSearchQuery.trim().toLowerCase();
    const entries = Array.from(ownerMap.values());
    if (!query) return entries;
    return entries.filter((owner) => owner.label.toLowerCase().includes(query) || owner.id.toLowerCase().includes(query));
  }, [plans, session?.user?.id, followSearchQuery, profilesById]);

  const filteredPlans = useMemo(() => {
    const userId = session?.user?.id;
    if (runFeedMode === 'following') {
      return sortedPlans.filter(
        (plan) => plan.ownerId === userId || followedOwnerIds.has(plan.ownerId)
      );
    }
    return sortedPlans.filter(
      (plan) => plan.ownerId !== userId && !followedOwnerIds.has(plan.ownerId)
    );
  }, [sortedPlans, followedOwnerIds, runFeedMode, session?.user?.id]);

  const clearRoute = () => {
    setStartPoint(null);
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
    setRouteElevationGainM(0);
    setRouteEstimatedDurationMin(0);
    setRouteDifficultyLabel('Unknown');
    setIsRoutePreviewLoading(false);
    setRouteError('');
  };

  const applySearchedCoordinateToPins = async (coordinate, pinMode = 'auto') => {
    if (planningMode === 'auto_loop' || pinMode === 'start') {
      setStartPoint(coordinate);
      setEndPoint(planningMode === 'auto_loop' ? coordinate : null);
      setRoutePoints([]);
      setRouteDistanceKm(0);
      return;
    }

    if (pinMode === 'finish') {
      if (!startPoint) {
        setRouteError('Set a start point first, then choose finish.');
        return;
      }
      setEndPoint(coordinate);
      setRoutePoints([]);
      setRouteDistanceKm(0);
      await buildRoute(startPoint, coordinate);
      return;
    }

    if (!startPoint) {
      setStartPoint(coordinate);
      setEndPoint(null);
      setRoutePoints([]);
      setRouteDistanceKm(0);
    } else {
      setEndPoint(coordinate);
      setRoutePoints([]);
      setRouteDistanceKm(0);
      await buildRoute(startPoint, coordinate);
    }
  };

  const centerMapOn = (coordinate) => {
    
    mapRef.current?.animateToRegion(
      {
        ...coordinate,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02
      },
      500
    );
  };

  const persistRecentSearch = async (entry) => {
    if (!session?.user?.id) return;
    const next = [entry, ...recentSearches.filter((s) => s.label !== entry.label)].slice(0, 8);
    setRecentSearches(next);
    const key = `run_planner:recent_searches:${session.user.id}`;
    await AsyncStorage.setItem(key, JSON.stringify(next));
  };

  const fetchPlaceSuggestions = async (query) => {
    if (!GOOGLE_MAPS_API_KEY) return;
    const q = query.trim();
    if (q.length < 3) {
      setPlaceSuggestions([]);
      return;
    }
    setIsSuggestionsLoading(true);
    try {
      const params = new URLSearchParams({
        address: q,
        key: GOOGLE_MAPS_API_KEY
      });
      const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
      const data = await response.json();
      if (data.status !== 'OK' || !data.results) {
        setPlaceSuggestions([]);
        return;
      }
      const suggestions = data.results.slice(0, 5).map((item, idx) => ({
        id: `${item.place_id || item.formatted_address}-${idx}`,
        label: item.formatted_address,
        coordinate: {
          latitude: item.geometry.location.lat,
          longitude: item.geometry.location.lng
        }
      }));
      setPlaceSuggestions(suggestions);
    } catch (_err) {
      setPlaceSuggestions([]);
    } finally {
      setIsSuggestionsLoading(false);
    }
  };

  const fetchNearbyCategorySuggestions = async (category) => {
    if (!GOOGLE_MAPS_API_KEY) return;
    const anchor = location
      ? { latitude: location.latitude, longitude: location.longitude }
      : region;
    setIsSuggestionsLoading(true);
    setPlaceSearchError('');
    try {
      const params = new URLSearchParams({
        location: `${anchor.latitude},${anchor.longitude}`,
        radius: '3500',
        keyword: category,
        key: GOOGLE_MAPS_API_KEY
      });
      const response = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`);
      const data = await response.json();
      if (data.status && data.status !== 'OK') {
        const details = data.error_message ? ` ${data.error_message}` : '';
        setPlaceSearchError(`Nearby search error: ${data.status}.${details}`);
        return;
      }
      const suggestions = (data.results || []).slice(0, 6).map((item, idx) => ({
        id: `${item.place_id || item.name}-${idx}`,
        label: item.vicinity ? `${item.name} - ${item.vicinity}` : item.name,
        coordinate: {
          latitude: item.geometry.location.lat,
          longitude: item.geometry.location.lng
        }
      }));
      setPlaceSuggestions(suggestions);
      setSearchFocused(true);
    } catch (_err) {
      setPlaceSearchError('Nearby search failed. Enable Places API and retry.');
    } finally {
      setIsSuggestionsLoading(false);
    }
  };

  const selectSuggestion = async (item, pinMode = 'auto') => {
    setPlaceQuery(item.label);
    await applySearchedCoordinateToPins(item.coordinate, pinMode);
    centerMapOn(item.coordinate);
    await persistRecentSearch(item);
    setPlaceSuggestions([]);
    setSearchFocused(false);
  };

  const searchPlaceAndSetPin = async (preset = null) => {
    const q = (preset?.label || placeQuery).trim();
    if (!q) return;
    setPlaceSearchError('');
    try {
      if (!GOOGLE_MAPS_API_KEY) {
        setPlaceSearchError('Set EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY in .env then restart Expo.');
        return;
      }
      let coordinate = preset?.coordinate || null;
      if (!coordinate) {
        const params = new URLSearchParams({
          address: q,
          key: GOOGLE_MAPS_API_KEY
        });
        const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
        const data = await response.json();
        if (data.status && data.status !== 'OK') {
          const details = data.error_message ? ` ${data.error_message}` : '';
          setPlaceSearchError(`Place search error: ${data.status}.${details}`);
          return;
        }
        const first = data.results?.[0];
        if (!first?.geometry?.location) {
          setPlaceSearchError('No place found. Try a more precise address.');
          return;
        }
        coordinate = {
          latitude: first.geometry.location.lat,
          longitude: first.geometry.location.lng
        };
      }
      await applySearchedCoordinateToPins(coordinate);
      centerMapOn(coordinate);
      await persistRecentSearch({
        id: `${q}-${coordinate.latitude}-${coordinate.longitude}`,
        label: q,
        coordinate
      });
      setPlaceSuggestions([]);
      setSearchFocused(false);
    } catch (_err) {
      setPlaceSearchError('Place search failed. Check key restrictions and network.');
    }
  };

  const fetchDirectionsCandidates = async ({
    fromPoint,
    toPoint,
    waypointPoints = [],
    alternatives = true
  }) => {
    const origin = `${fromPoint.latitude},${fromPoint.longitude}`;
    const destination = `${toPoint.latitude},${toPoint.longitude}`;
    const params = new URLSearchParams({
      origin,
      destination,
      mode: 'walking',
      key: GOOGLE_MAPS_API_KEY,
      alternatives: alternatives ? 'true' : 'false'
    });

    if (optionAvoidCars) {
      params.set('avoid', 'highways|tolls|ferries');
    }

    if (waypointPoints.length > 0) {
      const waypointString = waypointPoints
        .map((p) => `${p.latitude},${p.longitude}`)
        .join('|');
      params.set('waypoints', waypointString);
    }

    const response = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`);
    const data = await response.json();
    if (data.status && data.status !== 'OK') {
      const details = data.error_message ? ` ${data.error_message}` : '';
      throw new Error(`Directions API error: ${data.status}.${details}`);
    }
    if (!data.routes || data.routes.length === 0) {
      throw new Error('No route found. Try nearby points on valid paths.');
    }
    const candidates = [];
    for (const route of data.routes) {
      const polyline = route.overview_polyline?.points || '';
      const decoded = decodePolyline(polyline);
      if (decoded.length < 2) continue;
      const meters = route.legs?.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0) || 0;
      const exposure = computeRoadExposure(route);
      candidates.push({
        points: decoded,
        distanceKm: Number((meters / 1000).toFixed(2)),
        carRoadKm: Number(exposure.carRoadKm.toFixed(2)),
        pedestrianKm: Number(exposure.pedestrianKm.toFixed(2)),
        carRoadRatio: exposure.carRoadRatio,
        elevationGain: 0
      });
    }
    if (candidates.length === 0) {
      throw new Error('Route geometry missing. Try different points.');
    }
    return candidates;
  };

  const fetchElevationGain = async (points) => {
    if (!optionPreferHighElevation || points.length < 2) return 0;
    const sampleStep = Math.max(1, Math.floor(points.length / 24));
    const samples = points.filter((_, idx) => idx % sampleStep === 0).slice(0, 25);
    if (samples.length < 2) return 0;

    const locations = samples.map((p) => `${p.latitude},${p.longitude}`).join('|');
    const params = new URLSearchParams({
      locations,
      key: GOOGLE_MAPS_API_KEY
    });
    const response = await fetch(`https://maps.googleapis.com/maps/api/elevation/json?${params.toString()}`);
    const data = await response.json();
    if (data.status && data.status !== 'OK') return 0;
    const elevations = (data.results || []).map((item) => Number(item.elevation || 0));
    return elevationGainFromValues(elevations);
  };

  const scoreCandidate = (candidate, { targetDistanceKm = null }) => {
    let score = 0;
    if (targetDistanceKm !== null) {
      score -= Math.abs(candidate.distanceKm - targetDistanceKm) * 42;
    }
    if (optionAvoidCars) {
      score += candidate.pedestrianKm * 7;
      score -= candidate.carRoadKm * 11;
      score -= candidate.carRoadRatio * 150;
    } else {
      score -= candidate.carRoadRatio * 15;
    }
    if (optionPreferHighElevation) {
      score += candidate.elevationGain * 0.75;
    }
    if (!optionAvoidCars && !optionPreferHighElevation && targetDistanceKm === null) {
      score -= candidate.distanceKm * 0.2;
    }
    return score;
  };

  const selectBestCandidate = async (candidates, { targetDistanceKm = null }) => {
    const next = [...candidates];
    if (optionPreferHighElevation) {
      const enrich = next.slice(0, Math.min(5, next.length));
      await Promise.all(
        enrich.map(async (candidate) => {
          candidate.elevationGain = await fetchElevationGain(candidate.points);
        })
      );
    }

    let best = next[0];
    let bestScore = scoreCandidate(best, { targetDistanceKm });
    for (const candidate of next.slice(1)) {
      const candidateScore = scoreCandidate(candidate, { targetDistanceKm });
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    return best;
  };

  const buildManualRoute = async (fromPoint = startPoint, toPoint = endPoint) => {
    if (!fromPoint || !toPoint) return;
    const candidates = await fetchDirectionsCandidates({ fromPoint, toPoint, alternatives: true });
    const best = await selectBestCandidate(candidates, { targetDistanceKm: null });
    setRoutePoints(best.points);
    setRouteDistanceKm(best.distanceKm);
    await refreshRoutePreviewStats(best.points, best.distanceKm);
  };

  const buildAutoLoopRoute = async (fromPoint = startPoint) => {
    if (!fromPoint) return;
    const targetDistanceKm = Number(targetDistanceInput);
    if (!Number.isFinite(targetDistanceKm) || targetDistanceKm < 1) {
      throw new Error('Set a valid target distance (>= 1 km).');
    }

    const radiusKm = targetDistanceKm / (2 * Math.PI);
    const candidateBearings = [0, 45, 90, 135, 180, 225, 270, 315];
    const candidates = [];

    for (const bearing of candidateBearings) {
      const wp1 = destinationPoint(fromPoint, radiusKm, bearing + 30);
      const wp2 = destinationPoint(fromPoint, radiusKm, bearing + 150);
      const wp3 = destinationPoint(fromPoint, radiusKm, bearing + 270);
      try {
        const builtRoutes = await fetchDirectionsCandidates({
          fromPoint,
          toPoint: fromPoint,
          waypointPoints: [wp1, wp2, wp3],
          alternatives: true
        });
        for (const built of builtRoutes) {
          candidates.push(built);
        }
      } catch (_err) {
        // Ignore failed candidates and keep searching.
      }
    }

    if (candidates.length === 0) {
      throw new Error('No loop route found. Try another start point or distance.');
    }

    const best = await selectBestCandidate(candidates, { targetDistanceKm });

    setEndPoint(fromPoint);
    setRoutePoints(best.points);
    setRouteDistanceKm(best.distanceKm);
    await refreshRoutePreviewStats(best.points, best.distanceKm);
  };

  const buildRoute = async (fromPoint = startPoint, toPoint = endPoint) => {
    setIsRouting(true);
    setRouteError('');

    try {
      if (!GOOGLE_MAPS_API_KEY) {
        setRouteError('Set EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY in .env then restart Expo.');
        return;
      }
      if (planningMode === 'auto_loop') {
        await buildAutoLoopRoute(fromPoint);
      } else {
        await buildManualRoute(fromPoint, toPoint);
      }
    } catch (err) {
      setRouteError(err.message || 'Route generation failed. Check internet and API restrictions.');
    } finally {
      setIsRouting(false);
    }
  };

  const onMapPress = (event) => {
    const coordinate = event.nativeEvent.coordinate;
    setRouteError('');
    setPlaceSuggestions([]);
    setSearchFocused(false);

    if (planningMode === 'auto_loop') {
      setStartPoint(coordinate);
      setEndPoint(coordinate);
      setRoutePoints([]);
      setRouteDistanceKm(0);
      return;
    }

    if (!startPoint) {
      setStartPoint(coordinate);
      return;
    }

    if (!endPoint) {
      setEndPoint(coordinate);
      void buildRoute(startPoint, coordinate);
      return;
    }

    setStartPoint(coordinate);
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
  };

  const useCurrentLocation = () => {
    if (!location) {
      setRouteError('Current location unavailable. Enable location permissions.');
      return;
    }

    setRouteError('');
    setStartPoint({ latitude: location.latitude, longitude: location.longitude });
    setEndPoint(planningMode === 'auto_loop' ? { latitude: location.latitude, longitude: location.longitude } : null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
  };

  const savePlan = async () => {
    if (!canSave || !supabase || !session?.user?.id) return;

    const payload = {
      owner_id: session.user.id,
      title: title.trim(),
      date_time: dateTime.toISOString(),
      distance_km: Number(distanceKm.toFixed(2)),
      points: routePoints,
      start_point: startPoint,
      end_point: endPoint
    };

    const { error } = await supabase.from('run_plans').insert(payload);

    if (error) {
      if (error.code === '23503') {
        setPlansError(
          'Database relation mismatch (foreign key). Re-run the full Supabase SQL setup from README, then retry.'
        );
        return;
      }
      setPlansError(error.message || 'Could not save this run plan.');
      return;
    }

    setTitle('');
    clearRoute();
    await loadRemotePlans();
  };

  const toggleJoin = async (plan) => {
    if (!supabase || !session?.user?.id) return;
    if (plan.ownerId === session.user.id) return;

    if (plan.joined) {
      const { error } = await supabase
        .from('run_participants')
        .delete()
        .eq('run_id', plan.id)
        .eq('user_id', session.user.id);

      if (error) {
        if (error.code === '23503') {
          setPlansError(
            'Database relation mismatch (foreign key) on participants. Re-run the full Supabase SQL setup from README.'
          );
          return;
        }
        setPlansError(error.message || 'Could not leave run.');
        return;
      }
    } else {
      const { error } = await supabase.from('run_participants').insert({
        run_id: plan.id,
        user_id: session.user.id
      });

      if (error) {
        if (error.code === '23503') {
          setPlansError(
            'Database relation mismatch (foreign key) on participants. Re-run the full Supabase SQL setup from README.'
          );
          return;
        }
        setPlansError(error.message || 'Could not join run.');
        return;
      }
    }

    await loadRemotePlans();
  };

  const deletePlan = async (planId) => {
    if (!supabase || !session?.user?.id) return;
    const { error } = await supabase
      .from('run_plans')
      .delete()
      .eq('id', planId)
      .eq('owner_id', session.user.id);
    if (error) {
      if (error.code === '23503') {
        setPlansError(
          'Database relation mismatch (foreign key) on runs. Re-run the full Supabase SQL setup from README.'
        );
        return;
      }
      setPlansError(error.message || 'Could not delete run.');
      return;
    }
    await loadRemotePlans();
  };

  const persistRunSessions = async (nextSessions) => {
    if (!session?.user?.id) return;
    const key = `run_planner:run_sessions:${session.user.id}`;
    setRunSessions(nextSessions);
    await AsyncStorage.setItem(key, JSON.stringify(nextSessions));
  };

  const refreshRoutePreviewStats = async (points, distanceKm) => {
    const reqId = Date.now();
    routePreviewReqRef.current = reqId;
    setIsRoutePreviewLoading(true);
    let elevationGainM = 0;
    try {
      elevationGainM = await fetchElevationGain(points);
    } catch (_err) {
      elevationGainM = 0;
    }
    if (routePreviewReqRef.current !== reqId) return;

    const estDurationMin = distanceKm * performanceProfile.avgPaceMinPerKm + elevationGainM * 0.015;
    const distanceStress = distanceKm / Math.max(1, performanceProfile.avgDistanceKm);
    const elevationStress = elevationGainM / Math.max(40, performanceProfile.avgElevationM + 25);
    const durationStress = estDurationMin / Math.max(15, performanceProfile.avgDurationMin);
    const difficultyScore = distanceStress * 0.45 + elevationStress * 0.35 + durationStress * 0.2;

    setRouteElevationGainM(Math.round(elevationGainM));
    setRouteEstimatedDurationMin(Number(estDurationMin.toFixed(0)));
    setRouteDifficultyLabel(difficultyLabelFromScore(difficultyScore));
    setIsRoutePreviewLoading(false);
  };

  const submitLastRunRating = async () => {
    if (!pendingRatingSessionId) return;
    const enjoyment = Number(ratingEnjoyment);
    const perceivedDifficulty = Number(ratingDifficulty);
    if (enjoyment < 1 || perceivedDifficulty < 1) return;

    const next = runSessions.map((item) =>
      item.id === pendingRatingSessionId
        ? {
            ...item,
            enjoymentRating: enjoyment,
            perceivedDifficultyRating: perceivedDifficulty
          }
        : item
    );
    await persistRunSessions(next);
    setLastRunSummary((prev) =>
      prev && prev.id === pendingRatingSessionId
        ? {
            ...prev,
            enjoymentRating: enjoyment,
            perceivedDifficultyRating: perceivedDifficulty
          }
        : prev
    );
    setPendingRatingSessionId(null);
    setRatingEnjoyment(0);
    setRatingDifficulty(0);
  };

  const startRunTracking = async () => {
    if (routePoints.length < 2) {
      setRouteError('Generate a route before starting run tracking.');
      return;
    }
    if (isRunActive) return;

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setRouteError('Location permission is required to start run tracking.');
      return;
    }

    setRouteError('');
    setLastRunSummary(null);
    setIsRunActive(true);
    setRunTrack([]);
    setRunDistanceKm(0);
    setRunElapsedSec(0);
    setOffRouteMeters(0);
    maxOffRouteRef.current = 0;

    const startedAt = Date.now();
    runTimerRef.current = setInterval(() => {
      setRunElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    runWatchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 2000,
        distanceInterval: 3
      },
      (position) => {
        const coord = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        setRunTrack((prev) => {
          if (prev.length > 0) {
            const last = prev[prev.length - 1];
            const inc = haversineKm(last, coord);
            setRunDistanceKm((d) => Number((d + inc).toFixed(3)));
          }
          return [...prev, coord];
        });

        const dRoute = distanceToPolylineMeters(coord, routePoints);
        setOffRouteMeters(Math.round(dRoute));
        if (dRoute > maxOffRouteRef.current) maxOffRouteRef.current = dRoute;
      }
    );
  };

  const stopRunTracking = async () => {
    if (!isRunActive) return;
    setIsRunActive(false);

    if (runTimerRef.current) {
      clearInterval(runTimerRef.current);
      runTimerRef.current = null;
    }
    if (runWatchRef.current) {
      runWatchRef.current.remove();
      runWatchRef.current = null;
    }

    const avgPaceMinPerKm =
      runDistanceKm > 0 ? Number(((runElapsedSec / 60) / runDistanceKm).toFixed(2)) : 0;
    const summary = {
      id: `session_${Date.now()}`,
      createdAt: new Date().toISOString(),
      durationSec: runElapsedSec,
      distanceKm: Number(runDistanceKm.toFixed(2)),
      avgPaceMinPerKm,
      maxOffRouteMeters: Math.round(maxOffRouteRef.current),
      plannedDistanceKm: Number((routeDistanceKm || 0).toFixed(2)),
      elevationGainM: Number(routeElevationGainM || 0),
      estimatedDifficulty: routeDifficultyLabel
    };

    const next = [summary, ...runSessions].slice(0, 30);
    await persistRunSessions(next);
    setLastRunSummary(summary);
    setPendingRatingSessionId(summary.id);
    setRatingEnjoyment(0);
    setRatingDifficulty(0);
  };

  const toggleFollow = async (ownerId) => {
    if (!supabase || !session?.user?.id || !ownerId || ownerId === session.user.id) return;

    const isFollowing = followedOwnerIds.has(ownerId);
    if (isFollowing) {
      const { error } = await supabase
        .from('user_follows')
        .delete()
        .eq('user_id', session.user.id)
        .eq('follows_user_id', ownerId);
      if (error) {
        if (error.code === '23503') {
          setPlansError(
            'Database relation mismatch (foreign key) on follows. Re-run the full Supabase SQL setup from README.'
          );
          return;
        }
        setPlansError(error.message || 'Could not unfollow this runner.');
        return;
      }
    } else {
      const { error } = await supabase.from('user_follows').insert({
        user_id: session.user.id,
        follows_user_id: ownerId
      });
      if (error) {
        if (error.code === '23503') {
          setPlansError(
            'Database relation mismatch (foreign key) on follows. Re-run the full Supabase SQL setup from README.'
          );
          return;
        }
        setPlansError(error.message || 'Could not follow this runner.');
        return;
      }
    }
    await loadRemotePlans();
  };

  const dismissOnboarding = async () => {
    if (!session?.user?.id) return;
    const key = `run_planner:onboarding_seen:${session.user.id}`;
    await AsyncStorage.setItem(key, '1');
    setShowOnboarding(false);
  };

  const resolvePointLabel = async (point) => {
    if (!point) return 'N/A';
    try {
      const entries = await Location.reverseGeocodeAsync(point);
      if (!entries || entries.length === 0) return formatPoint(point);
      const top = entries[0];
      const pieces = [top.name, top.street, top.city].filter(Boolean);
      return pieces.length > 0 ? pieces.join(', ') : formatPoint(point);
    } catch (_err) {
      return formatPoint(point);
    }
  };

  const sharePlan = async (plan) => {
    const startLabel = await resolvePointLabel(plan.startPoint);
    const endLabel = await resolvePointLabel(plan.endPoint);
    const text = `${plan.title}\nWhen: ${formatWhen(plan.dateTime)}\nDistance: ${plan.distanceKm} km\nStart: ${startLabel}\nEnd: ${endLabel}\n${plan.participantCount} runner(s) joining.`;
    await Share.share({ message: text });
  };

  const openRunOnMap = (plan) => {
    setActiveTab('planner');
    setSelectedRunDetail(null);
    openPlannerPage(0);
    animatePanelToSnap('collapsed');
    if (plan.startPoint) setStartPoint(plan.startPoint);
    if (plan.endPoint) setEndPoint(plan.endPoint);
    if (plan.points?.length > 1) {
      setRoutePoints(plan.points);
      setRouteDistanceKm(Number(plan.distanceKm || 0));
    }

    requestAnimationFrame(() => {
      if (mapRef.current && plan.points?.length > 1) {
        mapRef.current.fitToCoordinates(plan.points, {
          edgePadding: { top: 90, right: 90, bottom: 110, left: 90 },
          animated: true
        });
      } else if (mapRef.current && plan.startPoint) {
        mapRef.current.animateToRegion(
          {
            latitude: plan.startPoint.latitude,
            longitude: plan.startPoint.longitude,
            latitudeDelta: 0.03,
            longitudeDelta: 0.03
          },
          450
        );
      }
    });
  };

  const onDateChange = (_event, selected) => {
    if (Platform.OS === 'ios') {
      if (selected) {
        setDateTime(selected);
      }
      return;
    }

    // Android flow: open date first, then time.
    if (!selected) {
      setShowPicker(false);
      return;
    }

    if (pickerMode === 'date') {
      const next = new Date(dateTime);
      next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      setDateTime(next);
      setPickerMode('time');
      setShowPicker(true);
      return;
    }

    const next = new Date(dateTime);
    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
    setDateTime(next);
    setShowPicker(false);
    setPickerMode('date');
  };

  const submitAuth = async () => {
    if (!supabase) return;
    setAuthError('');

    if (!email.trim() || !password.trim()) {
      setAuthError('Email and password are required.');
      return;
    }

    setIsAuthSubmitting(true);
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password
        });
        if (error) throw error;

        if (!data.session) {
          setAuthError('Check your inbox and confirm your email, then sign in.');
        }
      }
    } catch (err) {
      setAuthError(err.message || 'Authentication failed.');
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  const saveProfile = async () => {
    if (!supabase || !session?.user?.id || isSavingProfile) return;
    setIsSavingProfile(true);
    setProfileStatus('');
    const username = profileUsername.trim().toLowerCase().replace(/\s+/g, '_');
    const payload = {
      id: session.user.id,
      username: username || null,
      full_name: profileFullName.trim() || null,
      city: profileCity.trim() || null,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from('profiles').upsert(payload, { onConflict: 'id' });
    if (error) {
      setProfileStatus(error.message || 'Could not save profile.');
      setIsSavingProfile(false);
      return;
    }
    setProfileStatus('Profile saved.');
    await loadRemotePlans();
    setIsSavingProfile(false);
  };

  if (!isSupabaseConfigured) {
    return <MissingConfig />;
  }

  if (isAuthBooting) {
    return (
      <SafeAreaView style={styles.bootWrap}>
        <ActivityIndicator size="large" color="#13B48A" />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <AuthGate
        mode={authMode}
        onModeChange={setAuthMode}
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        onSubmit={submitAuth}
        isSubmitting={isAuthSubmitting}
        authError={authError}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {activeTab === 'planner' ? (
        <>
          <View style={styles.mapWrap}>
            <MapView
              ref={mapRef}
              style={styles.map}
              provider="google"
              initialRegion={region}
              onPress={onMapPress}
            >
              {startPoint && <Marker coordinate={startPoint} title="Start" pinColor="#13B48A" />}
              {endPoint && <Marker coordinate={endPoint} title="Finish" pinColor="#FF7A45" />}
              {routePoints.length > 1 && (
                <Polyline coordinates={routePoints} strokeWidth={5} strokeColor="#13B48A" />
              )}
            </MapView>

            <View style={styles.placeSearchBar}>
              <TextInput
                style={styles.placeSearchInput}
                placeholder="Search place or address"
                placeholderTextColor="#8aa1ab"
                value={placeQuery}
                onChangeText={(text) => {
                  setPlaceQuery(text);
                  setPlaceSearchError('');
                }}
                onFocus={() => setSearchFocused(true)}
                onSubmitEditing={searchPlaceAndSetPin}
                returnKeyType="search"
              />
              <Pressable style={styles.placeSearchButton} onPress={searchPlaceAndSetPin}>
                <Text style={styles.placeSearchButtonText}>Go</Text>
              </Pressable>
            </View>
            {searchFocused && (
              <View style={styles.nearbyCategoryRow}>
                <Pressable style={styles.nearbyChip} onPress={() => fetchNearbyCategorySuggestions('park')}>
                  <Text style={styles.nearbyChipText}>Parks</Text>
                </Pressable>
                <Pressable style={styles.nearbyChip} onPress={() => fetchNearbyCategorySuggestions('running track')}>
                  <Text style={styles.nearbyChipText}>Tracks</Text>
                </Pressable>
                <Pressable style={styles.nearbyChip} onPress={() => fetchNearbyCategorySuggestions('trailhead')}>
                  <Text style={styles.nearbyChipText}>Trailheads</Text>
                </Pressable>
              </View>
            )}
            {(searchFocused && (placeSuggestions.length > 0 || isSuggestionsLoading || (placeQuery.trim().length < 3 && recentSearches.length > 0))) && (
              <View style={styles.placeSuggestionsBox}>
                {isSuggestionsLoading && (
                  <Text style={styles.placeSuggestionLoading}>Searching...</Text>
                )}
                {!isSuggestionsLoading && placeSuggestions.length > 0 && (
                  <>
                    {placeSuggestions.map((item) => (
                      <View key={item.id} style={styles.placeSuggestionItem}>
                        <Pressable style={styles.placeSuggestionMain} onPress={() => selectSuggestion(item, 'auto')}>
                          <Text numberOfLines={1} style={styles.placeSuggestionText}>{item.label}</Text>
                        </Pressable>
                        <View style={styles.placeSuggestionActions}>
                          <Pressable style={styles.suggestionActionButton} onPress={() => selectSuggestion(item, 'start')}>
                            <Text style={styles.suggestionActionText}>Start</Text>
                          </Pressable>
                          <Pressable style={styles.suggestionActionButton} onPress={() => selectSuggestion(item, 'finish')}>
                            <Text style={styles.suggestionActionText}>Finish</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </>
                )}
                {!isSuggestionsLoading && placeSuggestions.length === 0 && placeQuery.trim().length < 3 && (
                  <>
                    <Text style={styles.placeSuggestionSectionTitle}>Recent searches</Text>
                    {recentSearches.map((item) => (
                      <View key={item.id} style={styles.placeSuggestionItem}>
                        <Pressable style={styles.placeSuggestionMain} onPress={() => selectSuggestion(item, 'auto')}>
                          <Text numberOfLines={1} style={styles.placeSuggestionText}>{item.label}</Text>
                        </Pressable>
                        <View style={styles.placeSuggestionActions}>
                          <Pressable style={styles.suggestionActionButton} onPress={() => selectSuggestion(item, 'start')}>
                            <Text style={styles.suggestionActionText}>Start</Text>
                          </Pressable>
                          <Pressable style={styles.suggestionActionButton} onPress={() => selectSuggestion(item, 'finish')}>
                            <Text style={styles.suggestionActionText}>Finish</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </View>
            )}
            {!!placeSearchError && <Text style={styles.placeSearchError}>{placeSearchError}</Text>}

            <View style={styles.bottomOverlay}>
              <View style={styles.metricChip}>
                <Text style={styles.metricLabel}>Distance</Text>
                <Text style={styles.metricValue}>{distanceKm.toFixed(2)} km</Text>
              </View>
              <View style={styles.metricChip}>
                <Text style={styles.metricLabel}>Pins</Text>
                <Text style={styles.metricValue}>{startPoint ? (endPoint ? '2/2' : '1/2') : '0/2'}</Text>
              </View>
            </View>

            {isRunActive && (
              <View style={styles.liveRunOverlay}>
                <Text style={styles.liveRunText}>Live: {runDistanceKm.toFixed(2)} km · {formatDuration(runElapsedSec)}</Text>
                <Text style={styles.liveRunSubText}>
                  {offRouteMeters > 70 ? `Off route: ${offRouteMeters}m` : `On route (${offRouteMeters}m)`}
                </Text>
              </View>
            )}

            {isRouting && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color="#ffffff" />
                <Text style={styles.loadingText}>Generating route...</Text>
              </View>
            )}
          </View>

          <Animated.View style={[styles.panel, { height: panelHeight }]}>
            <View style={styles.panelGrabArea} {...panelPanResponder.panHandlers}>
              <View style={styles.panelGrabber} />
              <Text style={styles.panelGrabText}>
                {panelSnap === 'collapsed'
                  ? 'Swipe up to open'
                  : panelSnap === 'half'
                    ? 'Swipe up for full or down to collapse'
                    : 'Swipe down for half/collapse'}
              </Text>
            </View>

            <View style={styles.panelHeader}>
              <BrandMark size={24} compact />
              <View style={styles.sortBar}>
                <Pressable
                  style={[styles.sortButton, plannerPage === 0 && styles.sortButtonActive]}
                  onPress={() => openPlannerPage(0)}
                >
                  <Text style={[styles.sortText, plannerPage === 0 && styles.sortTextActive]}>Upcoming</Text>
                </Pressable>
                <Pressable
                  style={[styles.sortButton, plannerPage === 1 && styles.sortButtonActive]}
                  onPress={() => openPlannerPage(1)}
                >
                  <Text style={[styles.sortText, plannerPage === 1 && styles.sortTextActive]}>Create</Text>
                </Pressable>
              </View>
            </View>

            {!isCreationCollapsed && (
              <ScrollView
                ref={plannerPagerRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(event) => {
                  const idx = Math.round(event.nativeEvent.contentOffset.x / panelPageWidth);
                  setPlannerPage(idx);
                }}
              >
                <View style={[styles.panelPage, { width: panelPageWidth }]}>
                  <View style={styles.listHeader}>
                    <Text style={styles.meta}>Swipe right for run creation</Text>
                    <View style={styles.sortBar}>
                      <Pressable
                        style={[styles.sortButton, runFeedMode === 'following' && styles.sortButtonActive]}
                        onPress={() => setRunFeedMode('following')}
                      >
                        <Text style={[styles.sortText, runFeedMode === 'following' && styles.sortTextActive]}>Following</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.sortButton, runFeedMode === 'explore' && styles.sortButtonActive]}
                        onPress={() => setRunFeedMode('explore')}
                      >
                        <Text style={[styles.sortText, runFeedMode === 'explore' && styles.sortTextActive]}>Explore</Text>
                      </Pressable>
                    </View>
                    <View style={styles.sortBar}>
                      <Pressable
                        style={[styles.sortButton, sortMode === 'date' && styles.sortButtonActive]}
                        onPress={() => setSortMode('date')}
                      >
                        <Text style={[styles.sortText, sortMode === 'date' && styles.sortTextActive]}>By Date</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.sortButton, sortMode === 'distance' && styles.sortButtonActive]}
                        onPress={() => setSortMode('distance')}
                      >
                        <Text style={[styles.sortText, sortMode === 'distance' && styles.sortTextActive]}>Nearest</Text>
                      </Pressable>
                    </View>
                  </View>

                  {plansLoading && (
                    <View style={styles.inlineLoading}>
                      <ActivityIndicator color="#13B48A" />
                      <Text style={styles.inlineLoadingText}>Syncing runs...</Text>
                    </View>
                  )}
                  <FlatList
                    data={filteredPlans}
                    keyExtractor={(item) => item.id}
                    showsVerticalScrollIndicator={false}
                    style={styles.pageList}
                    ListEmptyComponent={<Text style={styles.empty}>No plans yet. Create your first run.</Text>}
                    renderItem={({ item }) => {
                      const isOwner = item.ownerId === session.user.id;
                      const isFollowing = followedOwnerIds.has(item.ownerId);
                      return (
                        <Pressable style={styles.card} onPress={() => setSelectedRunDetail(item)}>
                          <View style={styles.cardHeader}>
                            <Text style={styles.cardTitle}>{item.title}</Text>
                            <View style={item.joined ? styles.joinedPill : styles.openPill}>
                              <Text style={styles.pillText}>{item.joined ? 'Joined' : 'Open'}</Text>
                            </View>
                          </View>

                          <Text style={styles.cardMeta}>{formatWhen(item.dateTime)}</Text>
                          <Text style={styles.cardMeta}>
                            {item.distanceKm} km · {item.participantCount} runner(s)
                          </Text>
                          <Text style={styles.cardMeta}>Start: {formatPoint(item.startPoint)}</Text>
                          {item.distanceFromCurrentKm !== null && (
                            <Text style={styles.cardMeta}>From you: {item.distanceFromCurrentKm} km</Text>
                          )}
                          <Text style={styles.cardMeta}>Host: {item.ownerLabel}</Text>

                          <View style={styles.cardActions}>
                            <Pressable
                              style={[
                                styles.cardActionButton,
                                item.joined && !isOwner && styles.cardActionButtonActive,
                                isOwner && styles.disabledButton
                              ]}
                              onPress={() => toggleJoin(item)}
                              disabled={isOwner}
                            >
                              <Text style={styles.cardActionText}>
                                {isOwner ? 'Your Run' : item.joined ? 'Leave' : 'Join'}
                              </Text>
                            </Pressable>

                            {!isOwner && (
                              <Pressable style={styles.cardActionButton} onPress={() => toggleFollow(item.ownerId)}>
                                <Text style={styles.cardActionText}>{isFollowing ? 'Unfollow' : 'Follow'}</Text>
                              </Pressable>
                            )}

                            {isOwner && (
                              <Pressable style={styles.cardActionButtonDanger} onPress={() => deletePlan(item.id)}>
                                <Text style={styles.cardActionTextDanger}>Delete</Text>
                              </Pressable>
                            )}

                            <Pressable style={styles.cardActionButton} onPress={() => sharePlan(item)}>
                              <Text style={styles.cardActionText}>Share</Text>
                            </Pressable>
                          </View>
                        </Pressable>
                      );
                    }}
                  />
                </View>

                <View style={[styles.panelPage, { width: panelPageWidth }]}>
                  <Text style={styles.meta}>{plannerStep}</Text>
                  <ScrollView
                    style={styles.createPageScroll}
                    contentContainerStyle={styles.createPageContent}
                    showsVerticalScrollIndicator={false}
                    nestedScrollEnabled
                  >
                    <TextInput
                      style={styles.input}
                      placeholder="Run title (e.g. River loop)"
                      placeholderTextColor="#7d8c95"
                      value={title}
                      onChangeText={setTitle}
                    />

                    <View style={styles.optionsSummaryRow}>
                      <Text style={styles.optionsSummaryText}>
                        {planningMode === 'manual' ? 'Manual' : `Loop ${targetDistanceInput || '5'} km`} ·
                        {optionAvoidCars ? ' minimize car-road exposure' : ' road-neutral'} ·
                        {optionPreferHighElevation ? ' maximize elevation' : ' elevation-neutral'}
                      </Text>
                      <Pressable
                        style={styles.optionsButton}
                        onPress={() => setShowRouteOptions((prev) => !prev)}
                      >
                        <Text style={styles.optionsButtonText}>{showRouteOptions ? 'Close Filters' : 'Filters'}</Text>
                      </Pressable>
                    </View>

                    {showRouteOptions && (
                      <View style={styles.optionsPanel}>
                        <View style={styles.sortBar}>
                          <Pressable
                            style={[styles.sortButton, planningMode === 'manual' && styles.sortButtonActive]}
                            onPress={() => {
                              setPlanningMode('manual');
                              setEndPoint(null);
                              setRoutePoints([]);
                              setRouteDistanceKm(0);
                            }}
                          >
                            <Text style={[styles.sortText, planningMode === 'manual' && styles.sortTextActive]}>Manual</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.sortButton, planningMode === 'auto_loop' && styles.sortButtonActive]}
                            onPress={() => {
                              setPlanningMode('auto_loop');
                              setEndPoint(startPoint || null);
                              setRoutePoints([]);
                              setRouteDistanceKm(0);
                            }}
                          >
                            <Text style={[styles.sortText, planningMode === 'auto_loop' && styles.sortTextActive]}>Auto Loop</Text>
                          </Pressable>
                        </View>

                        {planningMode === 'auto_loop' && (
                          <TextInput
                            style={styles.input}
                            placeholder="Target distance in km (e.g. 8)"
                            placeholderTextColor="#7d8c95"
                            keyboardType="decimal-pad"
                            value={targetDistanceInput}
                            onChangeText={setTargetDistanceInput}
                          />
                        )}

                        <View style={styles.sortBar}>
                          <Pressable
                            style={[styles.sortButton, optionAvoidCars && styles.sortButtonActive]}
                            onPress={() => setOptionAvoidCars((prev) => !prev)}
                          >
                            <Text style={[styles.sortText, optionAvoidCars && styles.sortTextActive]}>Avoid Car Roads</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.sortButton, optionPreferHighElevation && styles.sortButtonActive]}
                            onPress={() => setOptionPreferHighElevation((prev) => !prev)}
                          >
                            <Text style={[styles.sortText, optionPreferHighElevation && styles.sortTextActive]}>High Elevation</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}

                    {routePoints.length > 1 && (
                      <View style={styles.previewCard}>
                        <Text style={styles.previewTitle}>Run Preview</Text>
                        <Text style={styles.previewMeta}>Distance: {routeDistanceKm.toFixed(2)} km</Text>
                        <Text style={styles.previewMeta}>
                          Elevation Gain: {isRoutePreviewLoading ? 'Computing...' : `${routeElevationGainM} m`}
                        </Text>
                        <Text style={styles.previewMeta}>
                          Estimated Time: {isRoutePreviewLoading ? 'Computing...' : `${routeEstimatedDurationMin} min`}
                        </Text>
                        <Text style={styles.previewMeta}>
                          Difficulty (for you): {isRoutePreviewLoading ? 'Computing...' : routeDifficultyLabel}
                        </Text>
                      </View>
                    )}

                    <View style={styles.primaryActions}>
                      <Pressable
                        style={styles.primaryButton}
                        onPress={() => {
                          if (Platform.OS === 'android') {
                            setPickerMode('date');
                          }
                          setShowPicker(true);
                        }}
                      >
                        <Text style={styles.primaryButtonText}>Set Date & Time</Text>
                      </Pressable>

                      <Pressable
                        style={[styles.primaryButton, !canGenerate && styles.disabledButton]}
                        onPress={() => buildRoute()}
                        disabled={!canGenerate}
                      >
                        <Text style={styles.primaryButtonText}>
                          {planningMode === 'auto_loop' ? 'Generate Loop' : 'Generate Route'}
                        </Text>
                      </Pressable>
                    </View>

                    <Text style={styles.meta}>{dateTime.toLocaleString()}</Text>

                    {showPicker && (
                      <DateTimePicker
                        value={dateTime}
                        mode={Platform.OS === 'ios' ? 'datetime' : pickerMode}
                        onChange={onDateChange}
                      />
                    )}

                    <View style={styles.secondaryActions}>
                      <Pressable style={styles.ghostButton} onPress={useCurrentLocation}>
                        <Text style={styles.ghostButtonText}>Use My Location</Text>
                      </Pressable>

                      <Pressable style={styles.ghostButton} onPress={clearRoute}>
                        <Text style={styles.ghostButtonText}>Reset Route</Text>
                      </Pressable>
                    </View>

                    {!!routeError && <Text style={styles.errorText}>{routeError}</Text>}
                    {!!plansError && <Text style={styles.errorText}>{plansError}</Text>}

                    <View style={styles.primaryActions}>
                      <Pressable
                        style={[styles.primaryButton, routePoints.length < 2 && styles.disabledButton]}
                        onPress={startRunTracking}
                        disabled={isRunActive || routePoints.length < 2}
                      >
                        <Text style={styles.primaryButtonText}>Start Run</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.primaryButton, !isRunActive && styles.disabledButton]}
                        onPress={stopRunTracking}
                        disabled={!isRunActive}
                      >
                        <Text style={styles.primaryButtonText}>Stop Run</Text>
                      </Pressable>
                    </View>

                    {lastRunSummary && (
                      <View style={styles.sessionCard}>
                        <Text style={styles.sessionTitle}>Last Run</Text>
                        <Text style={styles.sessionMeta}>
                          {lastRunSummary.distanceKm} km in {formatDuration(lastRunSummary.durationSec)}
                        </Text>
                        <Text style={styles.sessionMeta}>
                          Avg pace: {lastRunSummary.avgPaceMinPerKm} min/km · Max off-route: {lastRunSummary.maxOffRouteMeters}m
                        </Text>
                        <Text style={styles.sessionMeta}>
                          Planned difficulty: {lastRunSummary.estimatedDifficulty}
                        </Text>
                        {!!lastRunSummary.enjoymentRating && !!lastRunSummary.perceivedDifficultyRating && (
                          <Text style={styles.sessionMeta}>
                            Rated {lastRunSummary.enjoymentRating}/5 enjoyment · {lastRunSummary.perceivedDifficultyRating}/5 difficulty
                          </Text>
                        )}

                        {pendingRatingSessionId === lastRunSummary.id && (
                          <View style={styles.ratingWrap}>
                            <Text style={styles.ratingLabel}>How much did you like this run?</Text>
                            <View style={styles.ratingRow}>
                              {[1, 2, 3, 4, 5].map((v) => (
                                <Pressable
                                  key={`enjoy-${v}`}
                                  style={[styles.ratingChip, ratingEnjoyment === v && styles.ratingChipActive]}
                                  onPress={() => setRatingEnjoyment(v)}
                                >
                                  <Text style={[styles.ratingChipText, ratingEnjoyment === v && styles.ratingChipTextActive]}>
                                    {v}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>

                            <Text style={styles.ratingLabel}>How difficult was it for you?</Text>
                            <View style={styles.ratingRow}>
                              {[1, 2, 3, 4, 5].map((v) => (
                                <Pressable
                                  key={`diff-${v}`}
                                  style={[styles.ratingChip, ratingDifficulty === v && styles.ratingChipActive]}
                                  onPress={() => setRatingDifficulty(v)}
                                >
                                  <Text style={[styles.ratingChipText, ratingDifficulty === v && styles.ratingChipTextActive]}>
                                    {v}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>

                            <Pressable
                              style={[
                                styles.saveButton,
                                (ratingEnjoyment < 1 || ratingDifficulty < 1) && styles.disabledButton
                              ]}
                              onPress={submitLastRunRating}
                              disabled={ratingEnjoyment < 1 || ratingDifficulty < 1}
                            >
                              <Text style={styles.saveButtonText}>Save Run Feedback</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    )}

                    <Pressable
                      style={[styles.saveButton, !canSave && styles.disabledButton]}
                      onPress={savePlan}
                      disabled={!canSave}
                    >
                      <Text style={styles.saveButtonText}>Save Plan</Text>
                    </Pressable>
                  </ScrollView>
                </View>
              </ScrollView>
            )}
          </Animated.View>
        </>
      ) : (
        <View style={styles.settingsWrap}>
          <View style={styles.settingsHeader}>
            <View style={styles.settingsTitleWrap}>
              <BrandMark size={24} compact />
              <Text style={styles.sectionTitle}>Account</Text>
            </View>
            <Pressable style={styles.signOutButtonDark} onPress={signOut}>
              <Text style={styles.signOutTextDark}>Sign Out</Text>
            </Pressable>
          </View>
          <Text style={styles.meta}>Logged in as {session.user.email}</Text>

          <Text style={styles.sectionTitle}>Profile</Text>
          <TextInput
            style={styles.input}
            placeholder="Display name"
            placeholderTextColor="#7d8c95"
            value={profileFullName}
            onChangeText={setProfileFullName}
          />
          <TextInput
            style={styles.input}
            placeholder="Username (e.g. loic_runs)"
            placeholderTextColor="#7d8c95"
            autoCapitalize="none"
            value={profileUsername}
            onChangeText={setProfileUsername}
          />
          <TextInput
            style={styles.input}
            placeholder="City"
            placeholderTextColor="#7d8c95"
            value={profileCity}
            onChangeText={setProfileCity}
          />
          {!!profileStatus && <Text style={styles.meta}>{profileStatus}</Text>}
          <Pressable
            style={[styles.saveButton, isSavingProfile && styles.disabledButton]}
            onPress={saveProfile}
            disabled={isSavingProfile}
          >
            {isSavingProfile ? (
              <ActivityIndicator color="#fff7ed" />
            ) : (
              <Text style={styles.saveButtonText}>Save Profile</Text>
            )}
          </Pressable>

          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Runs Created</Text>
              <Text style={styles.statValue}>{runStats.createdCount}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Runs Joined</Text>
              <Text style={styles.statValue}>{runStats.joinedCount}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Distance Planned</Text>
              <Text style={styles.statValue}>{runStats.totalDistanceKm} km</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Following</Text>
              <Text style={styles.statValue}>{runStats.followingCount}</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Friends (Followed Runners)</Text>
          <TextInput
            style={styles.input}
            placeholder="Search runners by name or id"
            placeholderTextColor="#7d8c95"
            value={followSearchQuery}
            onChangeText={setFollowSearchQuery}
          />
          <FlatList
            data={searchableOwners}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>No runners found.</Text>}
            renderItem={({ item }) => {
              const isFollowing = followedOwnerIds.has(item.id);
              return (
                <View style={styles.friendRow}>
                  <View style={styles.friendInfoWrap}>
                    <View style={styles.friendBadge}>
                      <Text style={styles.friendBadgeText}>{runnerInitials(item.id)}</Text>
                    </View>
                    <View>
                    <Text style={styles.friendName}>{item.label}</Text>
                    <Text style={styles.friendMeta}>{item.runCount} run(s) published</Text>
                    </View>
                  </View>
                  <Pressable style={styles.cardActionButton} onPress={() => toggleFollow(item.id)}>
                    <Text style={styles.cardActionText}>{isFollowing ? 'Unfollow' : 'Follow'}</Text>
                  </Pressable>
                </View>
              );
            }}
          />

          <Text style={styles.sectionTitle}>Followed Runners</Text>
          <FlatList
            data={followedRunners}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>No followed runners yet.</Text>}
            renderItem={({ item }) => (
              <View style={styles.friendRow}>
                <View style={styles.friendInfoWrap}>
                  <View style={styles.friendBadge}>
                    <Text style={styles.friendBadgeText}>{runnerInitials(item.id)}</Text>
                  </View>
                  <View>
                    <Text style={styles.friendName}>{item.label}</Text>
                    <Text style={styles.friendMeta}>{item.upcomingRuns} upcoming run(s)</Text>
                  </View>
                </View>
                <Pressable style={styles.cardActionButton} onPress={() => toggleFollow(item.id)}>
                  <Text style={styles.cardActionText}>Unfollow</Text>
                </Pressable>
              </View>
            )}
          />

          <Text style={styles.sectionTitle}>Recent Run Sessions</Text>
          <FlatList
            data={runSessions.slice(0, 8)}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>No tracked runs yet.</Text>}
            renderItem={({ item }) => (
              <View style={styles.friendRow}>
                <View>
                  <Text style={styles.friendName}>
                    {item.distanceKm} km · {formatDuration(item.durationSec)}
                  </Text>
                  <Text style={styles.friendMeta}>
                    Pace {item.avgPaceMinPerKm} min/km · Off-route max {item.maxOffRouteMeters}m
                  </Text>
                  {!!item.enjoymentRating && !!item.perceivedDifficultyRating && (
                    <Text style={styles.friendMeta}>
                      Enjoyment {item.enjoymentRating}/5 · Difficulty {item.perceivedDifficultyRating}/5
                    </Text>
                  )}
                </View>
                <Text style={styles.friendMeta}>{new Date(item.createdAt).toLocaleDateString()}</Text>
              </View>
            )}
          />
        </View>
      )}

      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tabButton, activeTab === 'planner' && styles.tabButtonActive]}
          onPress={() => setActiveTab('planner')}
        >
          <Text style={[styles.tabText, activeTab === 'planner' && styles.tabTextActive]}>Planner</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === 'settings' && styles.tabButtonActive]}
          onPress={() => setActiveTab('settings')}
        >
          <Text style={[styles.tabText, activeTab === 'settings' && styles.tabTextActive]}>Settings</Text>
        </Pressable>
      </View>

      {selectedRunDetail && (
        <View style={styles.detailOverlay}>
          <View style={styles.detailCard}>
            <View style={styles.detailHeader}>
              <Text style={styles.sectionTitle}>{selectedRunDetail.title}</Text>
              <Pressable style={styles.detailCloseButton} onPress={() => setSelectedRunDetail(null)}>
                <Text style={styles.detailCloseText}>Close</Text>
              </Pressable>
            </View>

            <Text style={styles.detailMeta}>When: {formatWhen(selectedRunDetail.dateTime)}</Text>
            <Text style={styles.detailMeta}>Distance: {selectedRunDetail.distanceKm} km</Text>
            <Text style={styles.detailMeta}>Start: {formatPoint(selectedRunDetail.startPoint)}</Text>
            <Text style={styles.detailMeta}>End: {formatPoint(selectedRunDetail.endPoint)}</Text>
            <Text style={styles.detailMeta}>Participants: {selectedRunDetail.participantCount}</Text>

            <View style={styles.detailActionsRow}>
              {selectedRunDetail.ownerId !== session.user.id ? (
                <Pressable
                  style={[
                    styles.detailActionButton,
                    selectedRunDetail.joined && styles.detailActionButtonActive
                  ]}
                  onPress={() => toggleJoin(selectedRunDetail)}
                >
                  <Text style={[styles.detailActionText, selectedRunDetail.joined && styles.detailActionTextActive]}>
                    {selectedRunDetail.joined ? 'Leave' : 'Join'}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.detailActionButtonDanger}
                  onPress={() => {
                    void deletePlan(selectedRunDetail.id);
                    setSelectedRunDetail(null);
                  }}
                >
                  <Text style={styles.detailActionTextDanger}>Delete</Text>
                </Pressable>
              )}
              <Pressable style={styles.detailActionButton} onPress={() => sharePlan(selectedRunDetail)}>
                <Text style={styles.detailActionText}>Share</Text>
              </Pressable>
              <Pressable style={styles.detailActionButton} onPress={() => openRunOnMap(selectedRunDetail)}>
                <Text style={styles.detailActionText}>Open on Map</Text>
              </Pressable>
            </View>

            <MapView
              key={selectedRunDetail.id}
              style={styles.detailMap}
              provider="google"
              scrollEnabled={false}
              rotateEnabled={false}
              pitchEnabled={false}
              initialRegion={{
                latitude: selectedRunDetail.startPoint?.latitude || region.latitude,
                longitude: selectedRunDetail.startPoint?.longitude || region.longitude,
                latitudeDelta: 0.03,
                longitudeDelta: 0.03
              }}
            >
              {selectedRunDetail.startPoint && (
                <Marker coordinate={selectedRunDetail.startPoint} title="Start" pinColor="#13B48A" />
              )}
              {selectedRunDetail.endPoint && (
                <Marker coordinate={selectedRunDetail.endPoint} title="Finish" pinColor="#FF7A45" />
              )}
              {selectedRunDetail.points?.length > 1 && (
                <Polyline coordinates={selectedRunDetail.points} strokeWidth={4} strokeColor="#13B48A" />
              )}
            </MapView>

            <Text style={styles.detailSectionTitle}>Participants</Text>
            <FlatList
              data={selectedRunDetail.participantIds || []}
              keyExtractor={(id) => id}
              style={styles.detailParticipantsList}
              renderItem={({ item }) => (
                <View style={styles.detailParticipantRow}>
                  <View style={styles.detailBadge}>
                    <Text style={styles.detailBadgeText}>{runnerInitials(item)}</Text>
                  </View>
                  <View style={styles.detailParticipantContent}>
                    <Text style={styles.detailParticipantName}>
                      {profileDisplayName(item, session.user.id, profilesById)}
                    </Text>
                    {item === selectedRunDetail.ownerId && <Text style={styles.detailParticipantMeta}>Host</Text>}
                  </View>
                </View>
              )}
              ListEmptyComponent={<Text style={styles.detailMeta}>No participants yet.</Text>}
            />
          </View>
        </View>
      )}

      {showOnboarding && (
        <View style={styles.onboardingBackdrop}>
          <View style={styles.onboardingCard}>
            <Text style={styles.sectionTitle}>Quick Tutorial</Text>
            <Text style={styles.onboardingLine}>1. Tap map to set start and finish.</Text>
            <Text style={styles.onboardingLine}>2. Generate route, set date/time, then save.</Text>
            <Text style={styles.onboardingLine}>3. Join, follow, and share runs with others.</Text>
            <Pressable style={styles.saveButton} onPress={dismissOnboarding}>
              <Text style={styles.saveButtonText}>Got It</Text>
            </Pressable>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bootWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f7f9'
  },
  authWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f7f9',
    padding: 16
  },
  authCard: {
    width: '100%',
    maxWidth: 430,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#d6e2e8',
    padding: 16
  },
  authTitle: {
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 24,
    color: '#0B1B2B'
  },
  authSubtitle: {
    marginTop: 6,
    marginBottom: 12,
    fontFamily: TYPEFACE,
    fontSize: 14,
    color: '#4E6472'
  },
  authToggleRow: {
    flexDirection: 'row',
    backgroundColor: '#edf3f6',
    borderRadius: 10,
    padding: 3,
    marginBottom: 12
  },
  authToggle: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8
  },
  authToggleActive: {
    backgroundColor: '#13B48A'
  },
  authToggleText: {
    fontFamily: TYPEFACE_MEDIUM,
    color: '#1d4554'
  },
  authToggleTextActive: {
    color: '#ffffff'
  },
  authInput: {
    borderWidth: 1,
    borderColor: '#c8d8df',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontFamily: TYPEFACE,
    fontSize: 14,
    color: '#0B1B2B',
    backgroundColor: '#ffffff',
    marginBottom: 10
  },
  authSubmit: {
    marginTop: 4,
    backgroundColor: '#FF7A45',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center'
  },
  authSubmitText: {
    color: '#ffffff',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 15
  },
  configVar: {
    fontFamily: TYPEFACE,
    color: '#244957',
    marginTop: 4
  },
  container: {
    flex: 1,
    backgroundColor: '#e8eef1'
  },
  tabBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: '#e8eef1',
    borderTopWidth: 1,
    borderTopColor: '#d5e3e9'
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: '#d8e4e9'
  },
  tabButtonActive: {
    backgroundColor: '#13B48A'
  },
  tabText: {
    color: '#1b4656',
    fontFamily: TYPEFACE_MEDIUM
  },
  tabTextActive: {
    color: '#f4fbff'
  },
  detailOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(8, 24, 34, 0.66)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14
  },
  detailCard: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '88%',
    backgroundColor: '#f9fcfd',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d1e0e7',
    padding: 14
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8
  },
  detailCloseButton: {
    backgroundColor: '#dbe9ef',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  detailCloseText: {
    color: '#184758',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  detailMeta: {
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 12,
    marginBottom: 4
  },
  detailActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    marginBottom: 8
  },
  detailActionButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#bdd0d9',
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    backgroundColor: '#edf5f8'
  },
  detailActionButtonActive: {
    borderColor: '#13B48A',
    backgroundColor: '#dff4ed'
  },
  detailActionButtonDanger: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e7bbb2',
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    backgroundColor: '#fff0ee'
  },
  detailActionText: {
    color: '#1f4d5d',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  detailActionTextActive: {
    color: '#0f7d61'
  },
  detailActionTextDanger: {
    color: '#ba3d2e',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  detailMap: {
    height: 180,
    borderRadius: 12,
    marginTop: 8,
    marginBottom: 10
  },
  detailSectionTitle: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 14,
    marginBottom: 6
  },
  detailParticipantsList: {
    maxHeight: 180
  },
  detailParticipantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ecf5f8',
    borderWidth: 1,
    borderColor: '#d6e4ea',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 6
  },
  detailBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#d5e6ee',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    overflow: 'hidden'
  },
  detailBadgeText: {
    color: '#0f3f50',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 11
  },
  detailParticipantContent: {
    flex: 1
  },
  detailParticipantName: {
    color: '#204957',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  detailParticipantMeta: {
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 11,
    marginTop: 1
  },
  mapWrap: {
    flex: 1.05,
    position: 'relative'
  },
  map: {
    flex: 1
  },
  placeSearchBar: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(248, 252, 255, 0.96)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#c8d8df',
    padding: 10,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center'
  },
  placeSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d4e1e7',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: '#0B1B2B',
    fontFamily: TYPEFACE
  },
  placeSearchButton: {
    backgroundColor: '#13B48A',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  placeSearchButtonText: {
    color: '#f4fbff',
    fontFamily: TYPEFACE_MEDIUM
  },
  placeSearchError: {
    position: 'absolute',
    top: 288,
    left: 12,
    right: 12,
    color: '#C0392B',
    backgroundColor: '#fee4e2',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  nearbyCategoryRow: {
    position: 'absolute',
    top: 66,
    left: 12,
    right: 12,
    flexDirection: 'row',
    gap: 8
  },
  nearbyChip: {
    backgroundColor: 'rgba(248, 252, 255, 0.95)',
    borderWidth: 1,
    borderColor: '#cfe0e7',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  nearbyChipText: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  placeSuggestionsBox: {
    position: 'absolute',
    top: 102,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(248, 252, 255, 0.98)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d2e1e8',
    maxHeight: 170,
    overflow: 'hidden'
  },
  placeSuggestionLoading: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    color: '#4E6472',
    fontFamily: TYPEFACE
  },
  placeSuggestionSectionTitle: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    color: '#4E6472',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  placeSuggestionItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2edf2',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  placeSuggestionMain: {
    flex: 1
  },
  placeSuggestionActions: {
    flexDirection: 'row',
    gap: 6
  },
  suggestionActionButton: {
    borderWidth: 1,
    borderColor: '#cddde5',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f6fbfd'
  },
  suggestionActionText: {
    color: '#205467',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 11
  },
  placeSuggestionText: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  topOverlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(10, 37, 46, 0.86)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  overlayTitle: {
    color: '#f8fafc',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 16
  },
  overlayStep: {
    marginTop: 4,
    color: '#d0e3ea',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: '#88aebc',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  signOutText: {
    color: '#e2f1f6',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  signOutButtonDark: {
    borderWidth: 1,
    borderColor: '#8aa3ae',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  signOutTextDark: {
    color: '#25424c',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  bottomOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    gap: 12
  },
  metricChip: {
    flex: 1,
    backgroundColor: 'rgba(248, 250, 252, 0.92)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12
  },
  metricLabel: {
    color: '#4f6871',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  metricValue: {
    color: '#0b3442',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 16
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(3, 18, 24, 0.35)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  liveRunOverlay: {
    position: 'absolute',
    top: 70,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(11, 27, 43, 0.88)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10
  },
  liveRunText: {
    color: '#f4fbff',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  liveRunSubText: {
    marginTop: 2,
    color: '#d2e7ee',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  loadingText: {
    marginTop: 8,
    color: '#ffffff',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 14
  },
  panel: {
    backgroundColor: '#f9fbfc',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    marginTop: -6,
    overflow: 'hidden',
    borderTopWidth: 1,
    borderColor: '#d7e4ea'
  },
  panelGrabArea: {
    alignItems: 'center',
    paddingBottom: 6
  },
  panelGrabber: {
    width: 52,
    height: 5,
    borderRadius: 999,
    backgroundColor: '#b8ccd5',
    marginBottom: 6
  },
  panelGrabText: {
    color: '#55707c',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  panelPage: {
    paddingBottom: 16
  },
  createPageScroll: {
    maxHeight: 380
  },
  createPageContent: {
    paddingBottom: 34
  },
  pageList: {
    maxHeight: 326
  },
  optionsSummaryRow: {
    backgroundColor: '#eef4f7',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cedbe1',
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 16
  },
  optionsSummaryText: {
    flex: 1,
    color: '#385864',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  optionsButton: {
    backgroundColor: '#dce8ed',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  optionsButtonText: {
    color: '#174455',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  optionsPanel: {
    borderWidth: 1,
    borderColor: '#d2dee4',
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#f8fbfd',
    marginBottom: 16
  },
  previewCard: {
    backgroundColor: '#edf7f3',
    borderWidth: 1,
    borderColor: '#cce5db',
    borderRadius: 12,
    padding: 10,
    marginBottom: 14
  },
  previewTitle: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 14
  },
  previewMeta: {
    marginTop: 4,
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  sessionCard: {
    backgroundColor: '#edf6fb',
    borderWidth: 1,
    borderColor: '#d0e1ea',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10
  },
  sessionTitle: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 14
  },
  sessionMeta: {
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 12,
    marginTop: 3
  },
  ratingWrap: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#cfe1ea'
  },
  ratingLabel: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12,
    marginBottom: 6
  },
  ratingRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10
  },
  ratingChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#bcd0d9',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fcff'
  },
  ratingChipActive: {
    backgroundColor: '#13B48A',
    borderColor: '#13B48A'
  },
  ratingChipText: {
    color: '#275060',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  ratingChipTextActive: {
    color: '#ffffff'
  },
  sectionTitle: {
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 18,
    color: '#0B1B2B',
    marginBottom: 8
  },
  input: {
    borderWidth: 1,
    borderColor: '#c8d8df',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontFamily: TYPEFACE,
    fontSize: 15,
    color: '#0B1B2B',
    backgroundColor: '#ffffff',
    marginBottom: 14
  },
  primaryActions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 4
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#13B48A',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center'
  },
  primaryButtonText: {
    color: '#f8fafc',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  disabledButton: {
    opacity: 0.5
  },
  meta: {
    marginTop: 10,
    marginBottom: 12,
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14
  },
  ghostButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#b8ccd5',
    borderRadius: 11,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#ffffff'
  },
  ghostButtonText: {
    color: '#184252',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  errorText: {
    color: '#C0392B',
    backgroundColor: '#fee4e2',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  saveButton: {
    backgroundColor: '#FF7A45',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4
  },
  saveButtonText: {
    color: '#fff7ed',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 15
  },
  listHeader: {
    marginBottom: 12
  },
  sortBar: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6
  },
  sortButton: {
    backgroundColor: '#d9e6eb',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12
  },
  sortButtonActive: {
    backgroundColor: '#13B48A'
  },
  sortText: {
    color: '#123948',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  sortTextActive: {
    color: '#f4fbff'
  },
  inlineLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10
  },
  inlineLoadingText: {
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  empty: {
    color: '#68808b',
    fontFamily: TYPEFACE,
    fontSize: 14,
    paddingVertical: 6
  },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d5e1e7',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#0B1B2B',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  cardTitle: {
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 16,
    color: '#0B1B2B',
    flex: 1,
    paddingRight: 8
  },
  openPill: {
    backgroundColor: '#d9f0ec',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  joinedPill: {
    backgroundColor: '#c7e4ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  pillText: {
    color: '#0f3a4a',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  cardMeta: {
    marginTop: 5,
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  cardActions: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 12
  },
  cardActionButton: {
    flex: 1,
    backgroundColor: '#eaf2f6',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center'
  },
  cardActionButtonDanger: {
    flex: 1,
    backgroundColor: '#fee4e2',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center'
  },
  cardActionButtonActive: {
    backgroundColor: '#c7e4ff'
  },
  cardActionText: {
    color: '#144558',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  cardActionTextDanger: {
    color: '#C0392B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  settingsWrap: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12
  },
  settingsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16
  },
  statCard: {
    width: '48%',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d5e1e7',
    borderRadius: 12,
    padding: 12
  },
  statLabel: {
    color: '#4b6773',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  statValue: {
    marginTop: 4,
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 20
  },
  friendRow: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d5e1e7',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  friendInfoWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 10
  },
  friendBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#d8e7ee',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginRight: 10
  },
  friendBadgeText: {
    color: '#0d4152',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  friendName: {
    color: '#0B1B2B',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 15
  },
  friendMeta: {
    color: '#4E6472',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  onboardingBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(8, 26, 33, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16
  },
  onboardingCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 14,
    backgroundColor: '#ffffff',
    padding: 18
  },
  onboardingLine: {
    marginBottom: 10,
    color: '#264955',
    fontFamily: TYPEFACE,
    fontSize: 14
  }
});
