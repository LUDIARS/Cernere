/** 登録画面の会場確認を開いた時点で始め、画面を離れたら (または確かめ直したら) 前の確認を止める。 */

import { useCallback, useEffect, useState } from "react";
import { runVenueCheck, type VenueCheckState } from "../../lib/venue-check";
import { venueRegistrationApi } from "../../lib/venue-registration-api";

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** enabled=false (V.O.B の Discord リンクから来たとき) は会場確認をしない。 */
export function useVenueCheck(enabled = true): { state: VenueCheckState; retry: () => void } {
  const [state, setState] = useState<VenueCheckState>({ phase: "starting", challengeId: null });
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void runVenueCheck({
      start: () => venueRegistrationApi.start(),
      sendToKiosk: (kiosk, nonce) => venueRegistrationApi.sendToKiosk(kiosk, nonce),
      status: (challengeId) => venueRegistrationApi.status(challengeId),
      sleep,
      now: () => Date.now(),
    }, setState, () => cancelled);
    return () => { cancelled = true; };
  }, [round, enabled]);

  const retry = useCallback(() => setRound((n) => n + 1), []);
  return { state, retry };
}
