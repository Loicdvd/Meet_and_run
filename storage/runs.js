import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'meet_and_run:plans';

export async function loadPlans() {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

export async function savePlans(plans) {
  await AsyncStorage.setItem(KEY, JSON.stringify(plans));
}

export function newPlanId() {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
