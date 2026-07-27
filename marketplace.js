/* =========================================================================
   marketplace.js — ماژول مارکت‌پلیس برای «جعبه لایتنر» (نسخه ۲)
   Vanilla JS، بدون وابستگی خارجی. self-contained و قابل drop-in.

   این نسخه مستقیماً به اسکیمای واقعی پنل مدیریت (admin.html) وصل است:
     market/items/{itemId}            -> { name, description, type, categoryId, tags,
                                            fileUrl, fileName, previewUrls,
                                            coinPrice, cashPrice, free,
                                            discount: {active,kind,value,startAt,endAt} | null,
                                            publishAt, published, active,
                                            salesCount, salesRevenueToman,
                                            createdAt, updatedAt }
     market/categories/{catId}        -> { name, order, createdAt }
     market/tags/{tagId}              -> { name, createdAt }
     market/subscriptionPlans/{id}    -> { name, period, priceToman, benefits, active, order, createdAt }

   داده‌ی کاربر (جدید در این نسخه):
     users/{uid}/wallet                        -> { coins, lastUpdated }
     users/{uid}/walletHistory/{txId}          -> { type, amount, reason, at }
     users/{uid}/purchases/{itemId}            -> { purchasedAt, method, price, active }
     users/{uid}/subscription                  -> { planId, startedAt, expiresAt, autoRenew, source }
     users/{uid}/favorites/{itemId}            -> true
     market/items/{itemId}/reviews/{reviewId}  -> { uid, userName, rating, text, createdAt }

   جزئیات کامل: MARKETPLACE_DESIGN_V2.md
   ========================================================================= */
(function (global) {
  'use strict';

  /* ============================= ADAPTERS =================================
     اگر نام متغیرهای global در پروژه‌ی شما فرق دارد، فقط همین بخش رو عوض کنید.
     ========================================================================= */
  const Adapters = {
    getAppState() { return global.state || {}; },
    t(key, vars) {
      if (typeof global.t === 'function') {
        const v = global.t(key);
        if (v && v !== key) return interpolate(v, vars);
      }
      let s = FALLBACK_STRINGS[key] || key;
      return interpolate(s, vars);
    },
    getUid() {
      const st = this.getAppState();
      return (st.authUser && st.authUser.uid) || null;
    },
    getUserName() {
      const st = this.getAppState();
      return (st.profile && st.profile.name) || (st.authUser && st.authUser.email) || 'کاربر';
    },
    isFirebaseReady() { return !!global.firebaseReady && !!global.fbDb; },
    db() { return global.fbDb || null; },
    firebase() { return global.firebase || null; },
    applyThemeColor(color) { if (typeof global.applyThemeColor === 'function') global.applyThemeColor(color); },
    applyThemeMode(mode) { if (typeof global.applyThemeMode === 'function') global.applyThemeMode(mode); },
    persistProfile() { if (typeof global.persistProfile === 'function') global.persistProfile(); },
    getUserId() {
      const st = this.getAppState();
      return (st.profile && st.profile.userId) || '';
    },
    // بسته‌ی کلمات خریداری‌شده رو مستقیم توی جعبه لایتنر کاربر (state.cards واقعی اپ) وارد می‌کنه.
    // کارت‌هایی که از قبل با همون متن و نوع وجود دارن، دوباره اضافه نمی‌شن (جلوگیری از تکراری).
    // برمی‌گردونه: تعداد کارت‌هایی که واقعاً تازه اضافه شدن.
    importCards(words) {
      if (typeof global.persistCards !== 'function' || !Array.isArray(words)) return 0;
      const st = this.getAppState();
      const today = typeof global.todayStr === 'function' ? global.todayStr() : new Date().toISOString().slice(0, 10);
      const nowIso = new Date().toISOString();
      st.cards = st.cards || [];
      const existing = new Set(st.cards.map((c) => (c.de || '').trim().toLowerCase() + '|' + (c.type || 'word')));
      const newCards = [];
      words.forEach((w) => {
        if (!w || !w.de || !w.fa) return;
        const key = String(w.de).trim().toLowerCase() + '|' + (w.type || 'word');
        if (existing.has(key)) return;
        existing.add(key);
        newCards.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, de: String(w.de).trim(), fa: String(w.fa).trim(), box: 1, nextReview: today, createdAt: nowIso, type: w.type === 'sentence' ? 'sentence' : 'word', categoryId: null });
      });
      if (!newCards.length) return 0;
      st.cards = [...st.cards, ...newCards];
      global.persistCards();
      return newCards.length;
    },
    isRTL() {
      const st = this.getAppState();
      return !st.uiLang || st.uiLang === 'fa';
    },
    // اگر اپ اصلی دستیار هوشمند (چت با API واقعی) دارد، این تابع را به همان وصل کنید.
    // پیش‌فرض: null یعنی از FAQ محلی + توصیه‌گر آفلاین استفاده کن.
    askAppAssistant: null, // function(promptText): Promise<string>
  };

  function interpolate(s, vars) {
    if (!vars) return s;
    Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }

  // آدرس Cloud Functionها برای پرداخت مستقیم — باید با بک‌اند واقعی پر شود.
  const PAYMENT_ENDPOINTS = {
    createRequest: null,
    verify: null,
  };

  const COIN_RULES = {
    XP_TO_COIN_RATIO: 10,
    DAILY_LOGIN: 5,
    DAILY_GOAL_HIT: 10,
  };

  const FALLBACK_STRINGS = {
    navMarket: 'مارکت', marketTitle: 'مارکت‌پلیس',
    marketSearchPlaceholder: 'جستجوی محصول...', marketCatAll: 'همه',
    marketFree: 'رایگان', marketOwned: 'مالک شده‌اید',
    marketBuyCoins: '{n} سکه', marketBuyToman: '{n} تومان',
    marketNotEnoughCoins: 'سکه کافی نیست', marketGetCoins: 'دریافت سکه بیشتر',
    marketWallet: 'کیف پول', marketHistory: 'تاریخچه خرید',
    marketApply: 'فعال‌سازی', marketApplied: 'فعال شد',
    marketSubMonthly: 'اشتراک ماهانه', marketSubYearly: 'اشتراک سالانه',
    marketPurchaseSuccess: 'خرید با موفقیت انجام شد', marketDownload: 'دانلود',
    marketAiSuggest: 'پیشنهاد هوشمند برای شما', marketAiAsk: 'از دستیار مارکت بپرس...',
    marketConfirmPurchase: 'مطمئنی می‌خوای این آیتم رو بخری؟',
    marketTabShowcase: 'ویترین', marketTabWallet: 'کیف من', marketTabSub: 'اشتراک',
    marketReviews: 'نظرات', marketWriteReview: 'ثبت نظر', marketNoReviews: 'هنوز نظری ثبت نشده.',
    marketFavAdd: 'افزودن به علاقه‌مندی‌ها', marketFavRemove: 'حذف از علاقه‌مندی‌ها',
    marketFavTab: 'علاقه‌مندی‌ها', marketNoFavs: 'چیزی به علاقه‌مندی‌ها اضافه نکردی.',
    marketAlreadyOwned: 'قبلاً این آیتم رو خریدی.', marketComingSoon: 'این آیتم هنوز منتشر نشده.',
    marketWordPackImported: '{n} کارت جدید به جعبه‌ی لایتنرت اضافه شد!', marketCoinsAdded: '{n} سکه به کیف پولت اضافه شد!',
    marketCouponLabel: 'کد تخفیف', marketCouponPlaceholder: 'کد تخفیف رو وارد کن...', marketCouponApply: 'اعمال',
    marketCouponActive: 'کد تخفیف فعال', marketCouponRemove: 'حذف کد',
    marketReferralTitle: 'معرفی دوستان', marketReferralYourCode: 'کد معرفی تو',
    marketReferralPlaceholder: 'کد دوستت رو وارد کن...', marketReferralApply: 'ثبت کد',
    marketReferralHint: 'کد معرفی خودت رو با دوستات به اشتراک بذار؛ هر دو طرف سکه می‌گیرید.',
  };

  /* ============================= LOCAL STORAGE (fallback آفلاین) ============ */
  const LS_KEYS = {
    WALLET: 'market_wallet_v2',
    PURCHASES: 'market_purchases_v2',
    SUBSCRIPTION: 'market_subscription_v2',
    VIEW_LOG: 'market_view_log_v2',
    HISTORY: 'market_wallet_history_v2',
    FAVORITES: 'market_favorites_v2',
    COUPON: 'market_active_coupon_v1',
  };

  function lsGet(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / privacy mode */ }
  }

  /* ============================= STATE ===================================== */
  const M = {
    _open: false,
    activeTab: 'showcase', // showcase | wallet | favorites | subscription
    activeCategory: 'all',
    searchQuery: '',
    items: [],
    categories: [],
    tags: [],
    plans: [],
    wallet: lsGet(LS_KEYS.WALLET, { coins: 0 }),
    purchases: lsGet(LS_KEYS.PURCHASES, {}),        // { itemId: {purchasedAt, method, price, active} }
    subscription: lsGet(LS_KEYS.SUBSCRIPTION, { planId: null }),
    walletHistory: lsGet(LS_KEYS.HISTORY, []),
    viewLog: lsGet(LS_KEYS.VIEW_LOG, {}),
    favorites: lsGet(LS_KEYS.FAVORITES, {}),         // { itemId: true }
    activeCoupon: lsGet(LS_KEYS.COUPON, null),        // { code, kind, value } | null
    couponMsg: null,
    referralMsg: null,
    selectedItemId: null,
    _detailModalOpen: false,
    _detailReviews: [],
    _detailReviewsLoaded: false,
    _initialized: false,
    _loading: false,
  };

  function persistAll() {
    lsSet(LS_KEYS.WALLET, M.wallet);
    lsSet(LS_KEYS.PURCHASES, M.purchases);
    lsSet(LS_KEYS.SUBSCRIPTION, M.subscription);
    lsSet(LS_KEYS.HISTORY, M.walletHistory);
    lsSet(LS_KEYS.VIEW_LOG, M.viewLog);
    lsSet(LS_KEYS.FAVORITES, M.favorites);
    lsSet(LS_KEYS.COUPON, M.activeCoupon);
  }

  /* ============================= FIREBASE LOAD (کاتالوگ) ==================== */
  function loadCatalog() {
    if (!Adapters.isFirebaseReady()) return Promise.resolve();
    const db = Adapters.db();
    return Promise.all([
      db.ref('market/items').once('value'),
      db.ref('market/categories').once('value'),
      db.ref('market/tags').once('value'),
      db.ref('market/subscriptionPlans').once('value'),
    ]).then(([itemSnap, catSnap, tagSnap, planSnap]) => {
      const itemVal = itemSnap.val() || {};
      const catVal = catSnap.val() || {};
      const tagVal = tagSnap.val() || {};
      const planVal = planSnap.val() || {};
      M.items = Object.keys(itemVal).map((id) => Object.assign({ id }, itemVal[id]));
      M.categories = Object.keys(catVal).map((id) => Object.assign({ id }, catVal[id])).sort((a, b) => (a.order || 0) - (b.order || 0));
      M.tags = Object.keys(tagVal).map((id) => Object.assign({ id }, tagVal[id]));
      M.plans = Object.keys(planVal).map((id) => Object.assign({ id }, planVal[id])).sort((a, b) => (a.order || 0) - (b.order || 0));
      renderIfOpen();
    }).catch((e) => { console.error('Marketplace: loadCatalog failed', e); });
  }

  function loadUserData() {
    if (!Adapters.isFirebaseReady()) return Promise.resolve();
    const uid = Adapters.getUid();
    if (!uid) return Promise.resolve();
    const db = Adapters.db();
    return Promise.all([
      db.ref('users/' + uid + '/wallet').once('value'),
      db.ref('users/' + uid + '/purchases').once('value'),
      db.ref('users/' + uid + '/subscription').once('value'),
      db.ref('users/' + uid + '/favorites').once('value'),
      db.ref('users/' + uid + '/walletHistory').orderByChild('at').limitToLast(50).once('value'),
    ]).then(([wSnap, pSnap, sSnap, fSnap, hSnap]) => {
      const w = wSnap.val();
      if (w && typeof w.coins === 'number') M.wallet = w;
      const p = pSnap.val();
      if (p) M.purchases = p;
      const s = sSnap.val();
      if (s) M.subscription = s;
      const f = fSnap.val();
      if (f) M.favorites = f;
      const h = hSnap.val();
      if (h) M.walletHistory = Object.keys(h).map((id) => Object.assign({ id }, h[id])).sort((a, b) => (b.at || 0) - (a.at || 0));
      persistAll();
      renderIfOpen();
    }).catch((e) => { console.error('Marketplace: loadUserData failed', e); });
  }

  function refreshAll() {
    M._loading = true;
    renderIfOpen();
    Promise.all([loadCatalog(), loadUserData()]).then(() => { M._loading = false; renderIfOpen(); });
  }

  /* ============================= PRICING / PUBLISH HELPERS ===================
     همان فرمول‌های admin.html — عمداً کپی شده تا رفتار ادمین و اپ کاربر یکسان باشد.
     ========================================================================= */
  function isDiscountLive(d, now) {
    now = now || Date.now();
    if (!d || !d.active) return false;
    if (d.startAt && now < d.startAt) return false;
    if (d.endAt && now > d.endAt) return false;
    return true;
  }
  function effectivePriceField(item, field, now) {
    const base = item[field] || 0;
    if (!base || item.free) return 0;
    const d = item.discount;
    let price = isDiscountLive(d, now)
      ? (d.kind === 'percent' ? Math.max(0, Math.round(base - (base * (d.value || 0) / 100))) : Math.max(0, Math.round(base - (d.value || 0))))
      : base;
    // کد تخفیفِ واردشده توسط کاربر (متفاوت از تخفیف سطحِ آیتم بالا) فقط روی قیمتِ تومانی اعمال می‌شه.
    if (field === 'cashPrice' && M.activeCoupon && price > 0) {
      price = M.activeCoupon.kind === 'percent'
        ? Math.max(0, Math.round(price - (price * (M.activeCoupon.value || 0) / 100)))
        : Math.max(0, Math.round(price - (M.activeCoupon.value || 0)));
    }
    return price;
  }
  function discountPercentLabel(item, now) {
    const d = item.discount;
    if (!isDiscountLive(d, now)) return 0;
    if (d.kind === 'percent') return d.value || 0;
    const base = item.coinPrice || item.cashPrice || 0;
    if (!base) return 0;
    return Math.round(((d.value || 0) / base) * 100);
  }
  function isPublished(item, now) {
    now = now || Date.now();
    if (item.active === false) return false;
    if (!item.publishAt) return !!item.published;
    return item.publishAt <= now;
  }
  function isOwned(itemId) { return !!(M.purchases[itemId] && M.purchases[itemId].active !== false); }
  function isFavorite(itemId) { return !!M.favorites[itemId]; }

  function visibleItems() {
    const now = Date.now();
    const curLang = typeof global.currentTargetLangCode === 'function' ? global.currentTargetLangCode() : null;
    return M.items.filter((it) => {
      if (!isPublished(it, now)) return false;
      // بسته‌ی کلمات مخصوص یه زبونه؛ فقط وقتی همون زبون فعاله نشونش بده (اگه langCode ست نشده، برای همه نشون بده).
      if (it.type === 'wordPack' && it.langCode && curLang && it.langCode !== curLang) return false;
      return true;
    });
  }

  /* ============================= WALLET API =================================
     نوشتن اتمیک روی users/{uid}/wallet/coins با runTransaction تا از race condition
     (مثلاً دو تب باز) جلوگیری شود. توضیح امنیتی: چون فعلاً بک‌اند سرور نداریم،
     نوشتن مستقیم wallet از کلاینت انجام می‌شود؛ Security Rules باید سقف افزایش را
     محدود کند (به MARKETPLACE_DESIGN_V2.md مراجعه کنید). وقتی سرور واقعی اضافه شد،
     فقط همین بخش (walletApi.spend/earn) باید با فراخوانی Cloud Function جایگزین شود.
     ========================================================================= */
  const walletApi = {
    balance() { return M.wallet.coins || 0; },

    _writeHistory(entry) {
      M.walletHistory.unshift(entry);
      M.walletHistory = M.walletHistory.slice(0, 100);
      persistAll();
      if (Adapters.isFirebaseReady() && Adapters.getUid()) {
        const uid = Adapters.getUid();
        Adapters.db().ref('users/' + uid + '/walletHistory').push(entry).catch(() => {});
      }
    },

    earn(amount, reason) {
      if (!amount || amount <= 0) return Promise.resolve(M.wallet.coins || 0);
      const uid = Adapters.getUid();
      if (Adapters.isFirebaseReady() && uid) {
        const ref = Adapters.db().ref('users/' + uid + '/wallet/coins');
        return ref.transaction((cur) => (cur || 0) + amount).then((res) => {
          const newBal = (res.snapshot && res.snapshot.val()) || ((M.wallet.coins || 0) + amount);
          M.wallet.coins = newBal;
          M.wallet.lastUpdated = Date.now();
          Adapters.db().ref('users/' + uid + '/wallet/lastUpdated').set(Date.now()).catch(() => {});
          this._writeHistory({ type: 'earn', amount, reason, at: Date.now() });
          renderIfOpen();
          return newBal;
        });
      }
      M.wallet.coins = (M.wallet.coins || 0) + amount;
      M.wallet.lastUpdated = Date.now();
      this._writeHistory({ type: 'earn', amount, reason, at: Date.now() });
      renderIfOpen();
      return Promise.resolve(M.wallet.coins);
    },

    // کسر اتمیک؛ اگر موجودی کافی نباشد، تراکنش abort می‌شود و false برمی‌گردد.
    spend(amount, reason) {
      const uid = Adapters.getUid();
      if (Adapters.isFirebaseReady() && uid) {
        const ref = Adapters.db().ref('users/' + uid + '/wallet/coins');
        return ref.transaction((cur) => {
          const bal = cur || 0;
          if (bal < amount) return; // abort: undefined یعنی لغو تراکنش
          return bal - amount;
        }).then((res) => {
          if (!res.committed) return false;
          const newBal = res.snapshot.val();
          M.wallet.coins = newBal;
          M.wallet.lastUpdated = Date.now();
          this._writeHistory({ type: 'spend', amount: -amount, reason, at: Date.now() });
          renderIfOpen();
          return true;
        }).catch(() => false);
      }
      if ((M.wallet.coins || 0) < amount) return Promise.resolve(false);
      M.wallet.coins -= amount;
      M.wallet.lastUpdated = Date.now();
      this._writeHistory({ type: 'spend', amount: -amount, reason, at: Date.now() });
      renderIfOpen();
      return Promise.resolve(true);
    },

    onXpEarned(xpAmount) {
      const coins = Math.floor(xpAmount / COIN_RULES.XP_TO_COIN_RATIO);
      if (coins > 0) return this.earn(coins, 'xp_conversion');
      return Promise.resolve(this.balance());
    },
    onDailyLogin() { return this.earn(COIN_RULES.DAILY_LOGIN, 'daily_login'); },
    onDailyGoalHit() { return this.earn(COIN_RULES.DAILY_GOAL_HIT, 'daily_goal_hit'); },
  };

  /* ============================= کد تخفیف (Coupon) =============================
     پنل مدیریت این کدها رو زیر market/discountCodes/{CODE} می‌سازه:
       { kind: 'percent'|'amount', value, expiresAt, maxUses, usedCount, active }
     کد فعال روی همین دستگاه (localStorage) نگه داشته می‌شه و روی effectivePriceField
     برای قیمت تومانی همه‌ی آیتم‌ها اعمال می‌شه (نگاه کن به تابع effectivePriceField بالا). */
  const couponApi = {
    async redeem(codeRaw) {
      const code = String(codeRaw || '').trim().toUpperCase();
      if (!code) return { ok: false, reason: 'empty' };
      if (!Adapters.isFirebaseReady()) return { ok: false, reason: 'offline' };
      const db = Adapters.db();
      const snap = await db.ref('market/discountCodes/' + code).once('value');
      const data = snap.val();
      if (!data || data.active === false) return { ok: false, reason: 'not_found' };
      const now = Date.now();
      if (data.expiresAt && data.expiresAt < now) return { ok: false, reason: 'expired' };
      if (data.maxUses && (data.usedCount || 0) >= data.maxUses) return { ok: false, reason: 'exhausted' };
      M.activeCoupon = { code, kind: data.kind === 'amount' ? 'amount' : 'percent', value: data.value || 0 };
      persistAll();
      db.ref('market/discountCodes/' + code + '/usedCount').transaction((c) => (c || 0) + 1).catch(() => {});
      return { ok: true, coupon: M.activeCoupon };
    },
    clear() { M.activeCoupon = null; persistAll(); },
  };

  /* ============================= معرفی دوستان (Referral) =======================
     کد معرفی همون آیدی یکتای خودِ کاربره (usernames/{id} -> uid که از قبل توی اپ هست).
     هر کاربر فقط یه‌بار می‌تونه کد یه نفر دیگه رو وارد کنه (با تراکنش اتمیک روی
     users/{uid}/referredBy تضمین می‌شه). به هر دو طرف سکه پاداش داده می‌شه. */
  const REFERRAL_RULES = { REFEREE_BONUS: 30, REFERRER_BONUS: 50 };
  const referralApi = {
    myCode() { return Adapters.getUserId(); },
    async redeem(codeRaw) {
      const code = String(codeRaw || '').trim();
      const uid = Adapters.getUid();
      if (!uid) return { ok: false, reason: 'not_logged_in' };
      if (!code) return { ok: false, reason: 'empty' };
      if (code === this.myCode()) return { ok: false, reason: 'self' };
      if (!Adapters.isFirebaseReady()) return { ok: false, reason: 'offline' };
      const db = Adapters.db();
      const snap = await db.ref('usernames/' + code).once('value');
      const refUid = snap.val();
      if (!refUid) return { ok: false, reason: 'not_found' };
      if (refUid === uid) return { ok: false, reason: 'self' };
      const res = await db.ref('users/' + uid + '/referredBy').transaction((cur) => cur || code);
      if (!res.committed || res.snapshot.val() !== code) return { ok: false, reason: 'already_used' };
      await walletApi.earn(REFERRAL_RULES.REFEREE_BONUS, 'referral_bonus_new');
      db.ref('users/' + refUid + '/wallet/coins').transaction((c) => (c || 0) + REFERRAL_RULES.REFERRER_BONUS).catch(() => {});
      db.ref('users/' + refUid + '/walletHistory').push({ type: 'earn', amount: REFERRAL_RULES.REFERRER_BONUS, reason: 'referral_bonus_referrer:' + uid, at: Date.now() }).catch(() => {});
      db.ref('users/' + refUid + '/referralCount').transaction((c) => (c || 0) + 1).catch(() => {});
      const st = Adapters.getAppState();
      if (st.profile) st.profile.referredBy = code;
      Adapters.persistProfile();
      return { ok: true };
    },
  };

  /* ============================= PURCHASE FLOW ================================
     مطابق سند: رایگان → مالکیت مستقیم؛ سکه → کسر اتمیک سپس مالکیت؛ تومان → mock/Cloud Function.
     پس از هر خرید موفق، salesCount و salesRevenueToman آیتم به‌روزرسانی می‌شود تا
     گزارش فروش پنل مدیریت (admin.html → مارکت → گزارش) داده‌ی واقعی نمایش دهد.
     ========================================================================= */
  function recordPurchase(item, method, price) {
    const uid = Adapters.getUid();
    const record = { purchasedAt: Date.now(), method, price, active: true };
    M.purchases[item.id] = record;
    persistAll();
    if (Adapters.isFirebaseReady() && uid) {
      const db = Adapters.db();
      db.ref('users/' + uid + '/purchases/' + item.id).set(record).catch(() => {});
      db.ref('market/items/' + item.id + '/salesCount').transaction((c) => (c || 0) + 1).catch(() => {});
      if (method !== 'free' && method === 'coins') {
        // فروش با سکه در گزارش تومانی حساب نمی‌شود؛ فقط شمارش فروش افزایش می‌یابد.
      } else if (method === 'toman' && price) {
        db.ref('market/items/' + item.id + '/salesRevenueToman').transaction((r) => (r || 0) + price).catch(() => {});
      }
    }
  }

  function purchaseFree(item) {
    if (isOwned(item.id)) return Promise.resolve({ ok: false, reason: 'already_owned' });
    recordPurchase(item, 'free', 0);
    return Promise.resolve({ ok: true });
  }

  function purchaseWithCoins(item) {
    if (isOwned(item.id)) return Promise.resolve({ ok: false, reason: 'already_owned' });
    const now = Date.now();
    const price = effectivePriceField(item, 'coinPrice', now);
    return walletApi.spend(price, 'purchase:' + item.id).then((success) => {
      if (!success) return { ok: false, reason: 'insufficient_coins' };
      recordPurchase(item, 'coins', price);
      return { ok: true };
    });
  }

  // پرداخت مستقیم (تومانی) — نیازمند Cloud Function واقعی. اگر endpoint تنظیم نشده
  // باشد، یک شبیه‌سازی محلی (برای تست UI) اجرا می‌شود.
  function purchaseWithToman(item) {
    const now = Date.now();
    const price = effectivePriceField(item, 'cashPrice', now);
    if (!PAYMENT_ENDPOINTS.createRequest) {
      return Promise.resolve().then(() => {
        recordPurchase(item, 'toman', price);
        return { ok: true, mocked: true };
      });
    }
    return fetch(PAYMENT_ENDPOINTS.createRequest, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, amount: price, uid: Adapters.getUid() }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.paymentUrl) {
          window.location.href = data.paymentUrl;
          return { ok: true, redirected: true };
        }
        return { ok: false, reason: 'gateway_error' };
      })
      .catch(() => ({ ok: false, reason: 'network_error' }));
  }

  /* ============================= ACTIVATE OWNED ITEM ========================= */
  function activateItem(item) {
    if (item.type === 'theme' && item.payload) {
      if (item.payload.themeColor) Adapters.applyThemeColor(item.payload.themeColor);
      if (item.payload.themeMode) Adapters.applyThemeMode(item.payload.themeMode);
    } else if (item.type === 'frame') {
      const st = Adapters.getAppState();
      if (st.profile) {
        st.profile.activeFrame = (item.payload && item.payload.frameId) || item.id;
        Adapters.persistProfile();
      }
    } else if (item.type === 'wordPack' && item.payload && Array.isArray(item.payload.words)) {
      const rec = M.purchases[item.id];
      if (rec && rec.wordPackImported) { showToast(Adapters.t('marketApplied')); return; }
      const added = Adapters.importCards(item.payload.words);
      if (rec) rec.wordPackImported = true;
      persistAll();
      const uid = Adapters.getUid();
      if (Adapters.isFirebaseReady() && uid) {
        Adapters.db().ref('users/' + uid + '/purchases/' + item.id + '/wordPackImported').set(true).catch(() => {});
      }
      showToast(Adapters.t('marketWordPackImported', { n: added }));
      return;
    } else if (item.type === 'coinPack' && item.payload && item.payload.coins) {
      const rec = M.purchases[item.id];
      if (rec && rec.coinPackClaimed) { showToast(Adapters.t('marketApplied')); return; }
      walletApi.earn(item.payload.coins, 'coin_pack:' + item.id).then(() => {
        if (rec) rec.coinPackClaimed = true;
        persistAll();
        const uid = Adapters.getUid();
        if (Adapters.isFirebaseReady() && uid) {
          Adapters.db().ref('users/' + uid + '/purchases/' + item.id + '/coinPackClaimed').set(true).catch(() => {});
        }
        showToast(Adapters.t('marketCoinsAdded', { n: item.payload.coins }));
        render();
      });
      return;
    }
    showToast(Adapters.t('marketApplied'));
  }

  /* ============================= FAVORITES ==================================== */
  const favoritesApi = {
    toggle(itemId) {
      const uid = Adapters.getUid();
      const next = !isFavorite(itemId);
      if (next) M.favorites[itemId] = true; else delete M.favorites[itemId];
      persistAll();
      if (Adapters.isFirebaseReady() && uid) {
        const ref = Adapters.db().ref('users/' + uid + '/favorites/' + itemId);
        if (next) ref.set(true).catch(() => {}); else ref.remove().catch(() => {});
      }
      render();
    },
  };

  /* ============================= REVIEWS ======================================= */
  const reviewsApi = {
    loadForItem(itemId) {
      if (!Adapters.isFirebaseReady()) return Promise.resolve([]);
      return Adapters.db().ref('market/items/' + itemId + '/reviews').orderByChild('createdAt').limitToLast(50).once('value')
        .then((snap) => {
          const val = snap.val() || {};
          return Object.keys(val).map((id) => Object.assign({ id }, val[id])).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        }).catch(() => []);
    },
    submit(itemId, rating, text) {
      const uid = Adapters.getUid();
      if (!uid) { showToast('برای ثبت نظر باید وارد حساب کاربری شوید.'); return Promise.resolve({ ok: false }); }
      if (!isOwned(itemId)) { showToast('فقط خریداران می‌توانند نظر ثبت کنند.'); return Promise.resolve({ ok: false }); }
      const entry = {
        uid, userName: Adapters.getUserName(),
        rating: Math.max(1, Math.min(5, rating || 5)),
        text: (text || '').slice(0, 500),
        createdAt: Date.now(),
      };
      if (!Adapters.isFirebaseReady()) return Promise.resolve({ ok: false });
      return Adapters.db().ref('market/items/' + itemId + '/reviews').push(entry).then(() => ({ ok: true, entry }));
    },
  };

  /* ============================= SUBSCRIPTION =============================== */
  function purchasePlan(planId) {
    const plan = M.plans.find((p) => p.id === planId);
    if (!plan) return Promise.resolve({ ok: false });
    return purchaseWithToman({ id: 'sub_' + planId, cashPrice: plan.priceToman, discount: null, free: false }).then((res) => {
      if (res && res.ok) {
        const now = Date.now();
        const durationMs = plan.period === 'yearly' ? 365 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
        M.subscription = { planId, startedAt: now, expiresAt: now + durationMs, autoRenew: false, source: 'toman' };
        persistAll();
        const uid = Adapters.getUid();
        if (Adapters.isFirebaseReady() && uid) Adapters.db().ref('users/' + uid + '/subscription').set(M.subscription).catch(() => {});
        renderIfOpen();
      }
      return res;
    });
  }

  function activePlan() {
    if (!M.subscription.planId || !M.subscription.expiresAt || M.subscription.expiresAt <= Date.now()) return null;
    return M.plans.find((p) => p.id === M.subscription.planId) || null;
  }

  function cancelSubscription() {
    M.subscription.autoRenew = false;
    persistAll();
    const uid = Adapters.getUid();
    if (Adapters.isFirebaseReady() && uid) Adapters.db().ref('users/' + uid + '/subscription/autoRenew').set(false).catch(() => {});
    renderIfOpen();
  }

  /* ============================= AI HELPERS ====================================
     پیشنهاد/تحلیل سمت کلاینت (آفلاین)؛ اگر Adapters.askAppAssistant وصل شده باشد
     (دستیار LLM واقعی اپ)، سوالات آزاد به همان ارجاع داده می‌شود.
     ========================================================================= */
  const AI = {
    suggestForUser(limit) {
      limit = limit || 4;
      const st = Adapters.getAppState();
      const now = Date.now();
      const ownedCategories = {};
      Object.keys(M.purchases).forEach((id) => {
        const it = M.items.find((x) => x.id === id);
        if (it && it.categoryId) ownedCategories[it.categoryId] = (ownedCategories[it.categoryId] || 0) + 1;
      });
      const league = (st.profile && st.profile.league) || '';
      const leagueBoost = { 'برنز': 1, 'نقره': 1.1, 'طلا': 1.2 };
      const boost = leagueBoost[league] || 1;

      return visibleItems()
        .filter((it) => !isOwned(it.id) && it.active !== false)
        .map((it) => {
          let score = (it.salesCount || 0) * 0.5;
          if (it.categoryId && ownedCategories[it.categoryId]) score += 40;
          if (isDiscountLive(it.discount, now)) score += 20;
          if (it.free) score += 10;
          if (isFavorite(it.id)) score += 25;
          score *= boost;
          return { item: it, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.item);
    },

    answerFAQ(question) {
      if (typeof Adapters.askAppAssistant === 'function') {
        return Promise.resolve(Adapters.askAppAssistant(
          'کاربر درباره مارکت‌پلیس اپ سوال پرسیده. فقط بر اساس آیتم‌های موجود پاسخ بده:\n' +
          visibleItems().map((it) => '- ' + it.name + ' (' + categoryLabel(it.categoryId) + '): ' + (it.description || '')).join('\n') +
          '\n\nسوال کاربر: ' + question
        ));
      }
      const q = (question || '').toLowerCase();
      const localFaq = [
        { match: ['رایگان', 'free'], answer: 'آیتم‌های رایگان با برچسب سبز «رایگان» مشخص شده‌اند و نیازی به سکه ندارند.' },
        { match: ['سکه', 'coin'], answer: 'سکه با تمرین روزانه، رسیدن به هدف روزانه و ورود مداوم به اپ به‌دست میاد.' },
        { match: ['اشتراک', 'subscription'], answer: 'اشتراک امکانات ویژه می‌ده و از تب «اشتراک» قابل خریداری‌ست.' },
        { match: ['تخفیف', 'discount'], answer: 'آیتم‌های دارای تخفیف با نشان قرمز و قیمت خط‌خورده مشخص می‌شن.' },
        { match: ['نظر', 'review'], answer: 'فقط کسانی که یک آیتم رو خریدن می‌تونن براش نظر ثبت کنن.' },
      ];
      const found = localFaq.find((f) => f.match.some((m) => q.includes(m)));
      return Promise.resolve(found ? found.answer : 'می‌تونی آیتم‌ها رو از دسته‌بندی‌های بالا فیلتر کنی یا جستجو کنی. برای سوال دقیق‌تر بپرس!');
    },

    logView(categoryId) {
      if (!categoryId) return;
      M.viewLog[categoryId] = (M.viewLog[categoryId] || 0) + 1;
      persistAll();
    },

    analyzePurchasesForDiscount() {
      const suggestions = [];
      Object.keys(M.viewLog).forEach((catId) => {
        const views = M.viewLog[catId];
        const boughtInCat = Object.keys(M.purchases).some((id) => {
          const it = M.items.find((x) => x.id === id);
          return it && it.categoryId === catId;
        });
        if (views >= 3 && !boughtInCat) {
          const candidate = visibleItems().find((it) => it.categoryId === catId && !isOwned(it.id));
          if (candidate) suggestions.push({ item: candidate, percent: 15, reason: 'viewed_not_bought' });
        }
      });
      return suggestions;
    },
  };

  /* ============================= UI HELPERS ================================== */
  function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'market-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function esc(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function categoryLabel(catId) {
    const c = M.categories.find((x) => x.id === catId);
    return c ? c.name : '';
  }

  function filteredItems() {
    let list = visibleItems();
    if (M.activeCategory !== 'all') list = list.filter((it) => it.categoryId === M.activeCategory);
    if (M.searchQuery.trim()) {
      const q = M.searchQuery.trim().toLowerCase();
      list = list.filter((it) => (it.name || '').toLowerCase().includes(q) || (it.description || '').toLowerCase().includes(q));
    }
    return list;
  }

  /* ============================= RENDER ======================================= */
  function root() { return document.getElementById('market-root'); }
  function renderIfOpen() { if (M._open) render(); }

  function iconSvg(name) {
    const icons = {
      bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 7h12l1 13H5L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>',
      coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5c0-1 1-2 3-2s3 1 3 2-1 1.5-3 1.5-3 .5-3 1.5 1 2 3 2 3-1 3-2"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12l6 6L20 6"/></svg>',
      sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/></svg>',
      heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
      heartFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
      star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21 7.5 13.5 2 9h7z"/></svg>',
    };
    return icons[name] || '';
  }

  function render() {
    const r = root();
    if (!r) return;
    r.innerHTML = renderOverlay();
  }

  function renderOverlay() {
    return (
      '<div class="market-overlay">' +
        renderHeader() +
        renderTabs() +
        '<div class="market-body">' + (M._loading ? renderLoading() : renderTabContent()) + '</div>' +
      '</div>' +
      renderDetailModal()
    );
  }

  function renderLoading() {
    return '<div class="market-empty">در حال بارگذاری...</div>';
  }

  function renderHeader() {
    return (
      '<div class="market-header">' +
        '<button class="market-close-btn" onclick="Marketplace.close()">' + iconSvg('close') + '</button>' +
        '<div class="market-header-title">' + esc(Adapters.t('marketTitle')) + '</div>' +
        '<div class="market-wallet-chip" onclick="Marketplace.setTab(\'wallet\')">' +
          iconSvg('coin') + '<span>' + walletApi.balance() + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTabs() {
    const tabs = [
      { id: 'showcase', label: Adapters.t('marketTabShowcase') },
      { id: 'wallet', label: Adapters.t('marketTabWallet') },
      { id: 'favorites', label: Adapters.t('marketFavTab') },
      { id: 'subscription', label: Adapters.t('marketTabSub') },
    ];
    return (
      '<div class="market-tabs">' +
        tabs.map((tb) =>
          '<button class="market-tab' + (M.activeTab === tb.id ? ' active' : '') + '" onclick="Marketplace.setTab(\'' + tb.id + '\')">' + esc(tb.label) + '</button>'
        ).join('') +
      '</div>'
    );
  }

  function renderTabContent() {
    if (M.activeTab === 'wallet') return renderWalletTab();
    if (M.activeTab === 'favorites') return renderFavoritesTab();
    if (M.activeTab === 'subscription') return renderSubscriptionTab();
    return renderShowcaseTab();
  }

  /* ---------- ویترین ---------- */
  function renderShowcaseTab() {
    const suggestions = AI.suggestForUser(4);
    const list = filteredItems();
    let html = '';
    html += renderAiBox(suggestions);
    html += (
      '<div class="market-search-row">' +
        '<input class="market-search-input" placeholder="' + esc(Adapters.t('marketSearchPlaceholder')) + '" ' +
        'value="' + esc(M.searchQuery) + '" oninput="Marketplace.setSearch(this.value)">' +
      '</div>'
    );
    html += '<div class="market-cats-scroll">';
    html += '<button class="market-cat-chip' + (M.activeCategory === 'all' ? ' active' : '') + '" onclick="Marketplace.setCategory(\'all\')">' + esc(Adapters.t('marketCatAll')) + '</button>';
    M.categories.forEach((c) => {
      html += '<button class="market-cat-chip' + (M.activeCategory === c.id ? ' active' : '') + '" onclick="Marketplace.setCategory(\'' + c.id + '\')">' + esc(c.name) + '</button>';
    });
    html += '</div>';
    if (!list.length) {
      html += '<div class="market-empty">🔍 آیتمی پیدا نشد.</div>';
    } else {
      html += '<div class="market-grid">' + list.map(renderCard).join('') + '</div>';
    }
    return html;
  }

  function renderAiBox(suggestions) {
    let html = '<div class="market-ai-box">';
    html += '<div class="market-ai-title">' + iconSvg('sparkle') + '<span>' + esc(Adapters.t('marketAiSuggest')) + '</span></div>';
    if (suggestions.length) {
      html += '<div class="market-ai-suggest-row">' + suggestions.map((it) => renderMiniCard(it)).join('') + '</div>';
    }
    html += (
      '<div class="market-ai-input-row">' +
        '<input id="market-ai-input" class="market-ai-input" placeholder="' + esc(Adapters.t('marketAiAsk')) + '">' +
        '<button class="market-icon-btn" onclick="Marketplace.askAi()">' + iconSvg('sparkle') + '</button>' +
      '</div>'
    );
    html += '<div id="market-ai-answer"></div>';
    html += '</div>';
    return html;
  }

  function renderMiniCard(it) {
    const now = Date.now();
    const price = effectivePriceField(it, 'coinPrice', now);
    const oldPrice = isDiscountLive(it.discount, now) ? (it.coinPrice || 0) : null;
    const img = it.previewUrls && it.previewUrls[0];
    return (
      '<div class="market-card" style="flex:0 0 130px" onclick="Marketplace.openDetail(\'' + it.id + '\')">' +
        '<div class="market-card-img-wrap">' + (img ? '<img src="' + esc(img) + '">' : '') + '</div>' +
        '<div class="market-card-body">' +
          '<div class="market-card-title">' + esc(it.name) + '</div>' +
          '<div class="market-card-price-row">' +
            (it.free ? '<span class="market-card-free-label">' + esc(Adapters.t('marketFree')) + '</span>' :
              '<span class="market-card-price">' + iconSvg('coin') + price + '</span>' +
              (oldPrice ? '<span class="market-card-price-old">' + oldPrice + '</span>' : '')) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderCard(it) {
    const now = Date.now();
    const owned = isOwned(it.id);
    const price = effectivePriceField(it, 'coinPrice', now);
    const oldPrice = isDiscountLive(it.discount, now) ? (it.coinPrice || 0) : null;
    const discountPct = discountPercentLabel(it, now);
    const img = it.previewUrls && it.previewUrls[0];
    AI.logView(it.categoryId);
    return (
      '<div class="market-card" onclick="Marketplace.openDetail(\'' + it.id + '\')">' +
        '<div class="market-card-img-wrap">' +
          (img ? '<img src="' + esc(img) + '">' : '') +
          (it.free ? '<span class="market-card-badge-free">' + esc(Adapters.t('marketFree')) + '</span>' : '') +
          (discountPct ? '<span class="market-card-badge-discount">-' + discountPct + '%</span>' : '') +
          (owned ? '<div class="market-card-badge-owned">' + iconSvg('check') + '</div>' : '') +
        '</div>' +
        '<div class="market-card-body">' +
          '<div class="market-card-title">' + esc(it.name) + '</div>' +
          '<div class="market-card-cat">' + esc(categoryLabel(it.categoryId)) + '</div>' +
          '<div class="market-card-price-row">' +
            (it.free ? '<span class="market-card-free-label">' + esc(Adapters.t('marketFree')) + '</span>' :
              '<span class="market-card-price">' + iconSvg('coin') + price + '</span>' +
              (oldPrice ? '<span class="market-card-price-old">' + oldPrice + '</span>' : '')) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /* ---------- کیف پول ---------- */
  function renderWalletTab() {
    let html = '';
    html += (
      '<div class="market-wallet-card">' +
        '<div class="market-wallet-balance">' + walletApi.balance() + '</div>' +
        '<div class="market-wallet-sub">' + esc(Adapters.t('marketWallet')) + '</div>' +
      '</div>'
    );
    html += (
      '<div class="market-sub-plan" style="margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:8px;">' + esc(Adapters.t('marketCouponLabel')) + '</div>' +
        (M.activeCoupon
          ? ('<div class="market-history-row"><span>' + esc(Adapters.t('marketCouponActive')) + ': ' + esc(M.activeCoupon.code) + '</span><button class="market-buy-btn secondary" style="width:auto;padding:6px 12px;margin:0;" onclick="Marketplace.clearCoupon()">' + esc(Adapters.t('marketCouponRemove')) + '</button></div>')
          : ('<div class="market-search-row" style="margin-bottom:0;"><input id="market-coupon-input" class="market-search-input" placeholder="' + esc(Adapters.t('marketCouponPlaceholder')) + '"><button class="market-buy-btn" style="width:auto;padding:0 16px;margin:0;" onclick="Marketplace.redeemCoupon(document.getElementById(\'market-coupon-input\'))">' + esc(Adapters.t('marketCouponApply')) + '</button></div>')) +
        (M.couponMsg ? ('<div style="font-size:12px;margin-top:8px;color:' + (M.couponMsg.ok ? 'var(--sage-strong)' : 'var(--wine)') + ';">' + esc(M.couponMsg.text) + '</div>') : '') +
      '</div>'
    );
    html += (
      '<div class="market-sub-plan" style="margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:6px;">' + esc(Adapters.t('marketReferralTitle')) + '</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">' + esc(Adapters.t('marketReferralHint')) + '</div>' +
        '<div class="market-history-row" style="margin-bottom:8px;"><span>' + esc(Adapters.t('marketReferralYourCode')) + '</span><b style="letter-spacing:0.5px;">' + esc(referralApi.myCode() || '—') + '</b></div>' +
        ((Adapters.getAppState().profile && Adapters.getAppState().profile.referredBy)
          ? ('<div style="font-size:12px;color:var(--sage-strong);">✓ کد دوستت رو قبلاً ثبت کردی</div>')
          : ('<div class="market-search-row" style="margin-bottom:0;"><input id="market-referral-input" class="market-search-input" placeholder="' + esc(Adapters.t('marketReferralPlaceholder')) + '"><button class="market-buy-btn" style="width:auto;padding:0 16px;margin:0;" onclick="Marketplace.redeemReferral(document.getElementById(\'market-referral-input\'))">' + esc(Adapters.t('marketReferralApply')) + '</button></div>')) +
        (M.referralMsg ? ('<div style="font-size:12px;margin-top:8px;color:' + (M.referralMsg.ok ? 'var(--sage-strong)' : 'var(--wine)') + ';">' + esc(M.referralMsg.text) + '</div>') : '') +
      '</div>'
    );
    const ownedIds = Object.keys(M.purchases).filter((id) => M.purchases[id].active !== false);
    if (!ownedIds.length) {
      html += '<div class="market-empty">هنوز چیزی نخریدی. برو به ویترین یه چیز خوب پیدا کن 🙂</div>';
    } else {
      html += '<div class="market-grid">' + ownedIds.map((id) => {
        const it = M.items.find((x) => x.id === id);
        return it ? renderOwnedCard(it) : '';
      }).join('') + '</div>';
    }
    html += '<h4 style="color:var(--muted);font-size:12.5px;margin:18px 0 10px;">' + esc(Adapters.t('marketHistory')) + '</h4>';
    if (!M.walletHistory.length) {
      html += '<div class="market-empty" style="padding:14px;">تراکنشی ثبت نشده.</div>';
    } else {
      html += M.walletHistory.slice(0, 20).map((h) => (
        '<div class="market-history-row">' +
          '<span>' + esc(historyLabel(h)) + '</span>' +
          '<span class="market-history-amount ' + (h.amount >= 0 ? 'positive' : 'negative') + '">' + (h.amount >= 0 ? '+' : '') + h.amount + '</span>' +
        '</div>'
      )).join('');
    }
    return html;
  }

  function historyLabel(h) {
    const map = { daily_login: 'پاداش ورود روزانه', daily_goal_hit: 'تکمیل هدف روزانه', xp_conversion: 'تبدیل امتیاز' };
    if (h.reason && h.reason.startsWith('purchase:')) {
      const pid = h.reason.replace('purchase:', '');
      const it = M.items.find((x) => x.id === pid);
      return 'خرید ' + (it ? it.name : pid);
    }
    return map[h.reason] || h.reason || '';
  }

  function renderOwnedCard(it) {
    const img = it.previewUrls && it.previewUrls[0];
    const rec = M.purchases[it.id];
    const boughtAt = rec && rec.purchasedAt ? new Date(rec.purchasedAt).toLocaleString('fa-IR') : '';
    return (
      '<div class="market-card">' +
        '<div class="market-card-img-wrap">' + (img ? '<img src="' + esc(img) + '">' : '') + '</div>' +
        '<div class="market-card-body">' +
          '<div class="market-card-title">' + esc(it.name) + '</div>' +
          (boughtAt ? '<div style="font-size:10.5px;color:var(--muted);margin:2px 0 6px;">خرید: ' + esc(boughtAt) + '</div>' : '') +
          '<button class="market-buy-btn owned" style="padding:8px;font-size:12px;" onclick="Marketplace.activate(\'' + it.id + '\')">' + esc(Adapters.t('marketApply')) + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  /* ---------- علاقه‌مندی‌ها ---------- */
  function renderFavoritesTab() {
    const ids = Object.keys(M.favorites);
    if (!ids.length) return '<div class="market-empty">' + esc(Adapters.t('marketNoFavs')) + '</div>';
    const items = ids.map((id) => M.items.find((x) => x.id === id)).filter(Boolean);
    if (!items.length) return '<div class="market-empty">' + esc(Adapters.t('marketNoFavs')) + '</div>';
    return '<div class="market-grid">' + items.map(renderCard).join('') + '</div>';
  }

  /* ---------- اشتراک ---------- */
  function renderSubscriptionTab() {
    let html = '';
    const plan = activePlan();
    if (plan) {
      const exp = new Date(M.subscription.expiresAt).toLocaleDateString('fa-IR');
      html += (
        '<div class="market-sub-status">' +
          '✅ اشتراک ' + esc(plan.name) + ' فعاله (انقضا: ' + exp + ')' +
          '<br><button class="market-buy-btn secondary" style="margin-top:10px;" onclick="Marketplace.cancelSub()">لغو تمدید خودکار</button>' +
        '</div>'
      );
    }
    const activePlans = M.plans.filter((p) => p.active !== false);
    if (!activePlans.length) {
      html += '<div class="market-empty">فعلاً پلن اشتراکی تعریف نشده.</div>';
    } else {
      html += activePlans.map((p) => renderSubPlan(p)).join('');
    }
    return html;
  }

  function renderSubPlan(plan) {
    return (
      '<div class="market-sub-plan">' +
        '<div class="market-sub-plan-title">' + esc(plan.name) + ' <span style="font-size:11px;color:var(--muted)">(' + (plan.period === 'yearly' ? 'سالانه' : 'ماهانه') + ')</span></div>' +
        '<div class="market-sub-plan-price">' + (plan.priceToman || 0).toLocaleString('fa-IR') + ' تومان</div>' +
        '<ul class="market-sub-benefits">' +
          (plan.benefits || []).map((b) => '<li>' + iconSvg('check') + '<span>' + esc(b) + '</span></li>').join('') +
        '</ul>' +
        '<button class="market-buy-btn" onclick="Marketplace.buySubscription(\'' + plan.id + '\')">خرید</button>' +
      '</div>'
    );
  }

  /* ---------- مودال جزئیات + نظرات ---------- */
  function renderDetailModal() {
    if (!M._detailModalOpen || !M.selectedItemId) return '';
    const it = M.items.find((x) => x.id === M.selectedItemId);
    if (!it) return '';
    const now = Date.now();
    const owned = isOwned(it.id);
    const published = isPublished(it, now);
    const price = effectivePriceField(it, 'coinPrice', now);
    const cashPrice = effectivePriceField(it, 'cashPrice', now);
    const discountPct = discountPercentLabel(it, now);
    const enoughCoins = walletApi.balance() >= price;
    const fav = isFavorite(it.id);
    const img = it.previewUrls && it.previewUrls[0];

    let buyBtn;
    if (!published) {
      buyBtn = '<button class="market-buy-btn disabled">' + esc(Adapters.t('marketComingSoon')) + '</button>';
    } else if (owned) {
      buyBtn = '<button class="market-buy-btn owned" onclick="Marketplace.activate(\'' + it.id + '\')">' + esc(Adapters.t('marketApply')) + '</button>';
    } else if (it.free) {
      buyBtn = '<button class="market-buy-btn" onclick="Marketplace.buy(\'' + it.id + '\', \'free\')">' + esc(Adapters.t('marketFree')) + '</button>';
    } else {
      buyBtn = '';
      if (it.coinPrice) {
        buyBtn += (
          '<button class="market-buy-btn' + (enoughCoins ? '' : ' disabled') + '" onclick="Marketplace.buy(\'' + it.id + '\', \'coins\')">' +
            iconSvg('coin') + ' ' + Adapters.t('marketBuyCoins', { n: price }) +
          '</button>'
        );
        if (!enoughCoins) buyBtn += '<button class="market-buy-btn secondary" onclick="Marketplace.setTab(\'wallet\')">' + esc(Adapters.t('marketGetCoins')) + '</button>';
      }
      if (it.cashPrice) {
        buyBtn += '<button class="market-buy-btn secondary" onclick="Marketplace.buy(\'' + it.id + '\', \'toman\')">' + Adapters.t('marketBuyToman', { n: cashPrice.toLocaleString('fa-IR') }) + '</button>';
      }
    }

    return (
      '<div class="market-modal-overlay" onclick="if(event.target===this) Marketplace.closeDetail()">' +
        '<div class="market-modal">' +
          '<div class="market-modal-drag"></div>' +
          (img ? '<img class="market-modal-img" src="' + esc(img) + '">' : '') +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">' +
            '<div class="market-modal-title">' + esc(it.name) + (discountPct ? ' <span style="color:var(--wine);font-size:13px;">(' + discountPct + '% تخفیف)</span>' : '') + '</div>' +
            '<button class="market-icon-btn" onclick="Marketplace.toggleFavorite(\'' + it.id + '\')" title="' + esc(Adapters.t(fav ? 'marketFavRemove' : 'marketFavAdd')) + '">' + iconSvg(fav ? 'heartFilled' : 'heart') + '</button>' +
          '</div>' +
          '<div class="market-modal-desc">' + esc(it.description || '') + '</div>' +
          '<div class="market-modal-price-box">' +
            '<span>' + esc(categoryLabel(it.categoryId)) + '</span>' +
            (it.free ? '<span class="market-card-free-label">' + esc(Adapters.t('marketFree')) + '</span>' :
              '<span class="market-modal-price-num">' + iconSvg('coin') + price + '</span>') +
          '</div>' +
          buyBtn +
          renderReviewsSection(it) +
        '</div>' +
      '</div>'
    );
  }

  function renderReviewsSection(it) {
    const owned = isOwned(it.id);
    const reviews = M._detailReviews;
    const avg = reviews.length ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1) : null;
    let html = '<div class="market-reviews-section">';
    html += '<h4 style="color:var(--muted);font-size:12.5px;margin:16px 0 8px;display:flex;align-items:center;gap:6px">' + esc(Adapters.t('marketReviews')) + (avg ? ' · ' + iconSvg('star') + ' ' + avg : '') + '</h4>';
    if (owned) {
      html += (
        '<div class="market-review-form">' +
          '<select id="market-review-rating" class="market-search-input" style="max-width:90px">' +
            [5, 4, 3, 2, 1].map((n) => '<option value="' + n + '">' + n + ' ★</option>').join('') +
          '</select>' +
          '<input id="market-review-text" class="market-search-input" placeholder="نظرت رو بنویس...">' +
          '<button class="market-buy-btn secondary" style="margin-top:8px" onclick="Marketplace.submitReview(\'' + it.id + '\')">' + esc(Adapters.t('marketWriteReview')) + '</button>' +
        '</div>'
      );
    }
    if (!reviews.length) {
      html += '<div class="market-empty" style="padding:10px 0;font-size:12px">' + esc(Adapters.t('marketNoReviews')) + '</div>';
    } else {
      html += reviews.map((r) => (
        '<div class="market-review-row">' +
          '<div style="display:flex;justify-content:space-between;font-size:12px">' +
            '<strong>' + esc(r.userName || 'کاربر') + '</strong>' +
            '<span>' + '★'.repeat(r.rating || 0) + '</span>' +
          '</div>' +
          (r.text ? '<div style="font-size:12px;color:var(--muted);margin-top:4px">' + esc(r.text) + '</div>' : '') +
        '</div>'
      )).join('');
    }
    html += '</div>';
    return html;
  }

  /* ============================= PUBLIC API =================================== */
  const Marketplace = {
    open() {
      M._open = true;
      ensureRootMounted();
      render();
      const r = root();
      if (r) r.classList.remove('hide');
      if (!M._initialized) { M._initialized = true; refreshAll(); } else { refreshAll(); }
    },
    // مثل open() دیتا رو بارگذاری می‌کنه ولی هیچ رابط کاربری‌ای باز نمی‌کنه؛ برای جاهایی مثل
    // صفحه‌ی پروفایل که باید بدونن کاربر چه آیتم‌هایی (مثلاً قاب پروفایل) رو مالکه، بدون این‌که
    // کاربر لزوماً وارد صفحه‌ی مارکت شده باشه.
    ensureLoaded() {
      if (M._initialized) return;
      M._initialized = true;
      M._loading = true;
      Promise.all([loadCatalog(), loadUserData()]).then(() => {
        M._loading = false;
        renderIfOpen();
        // اپ اصلی (index.html) هم باید دوباره رندر بشه تا اگه فریمی فعاله، همون لحظه دور
        // آواتار نشون داده بشه، نه فقط وقتی کاربر بعداً وارد صفحه‌ای بشه که دوباره رندر می‌کنه.
        if (typeof global.render === 'function') global.render();
      });
    },
    close() {
      M._open = false;
      const r = root();
      if (r) r.classList.add('hide');
    },
    setTab(tab) { M.activeTab = tab; render(); },
    setCategory(cat) { M.activeCategory = cat; render(); },
    setSearch(q) { M.searchQuery = q; render(); },

    // برمی‌گردونه: لینک عکسِ قابِ فعلاً انتخاب‌شده‌ی کاربر (اگه فریمی خریده/فعال کرده و واقعاً
    // مالکشه)، وگرنه null. index.html این رو صدا می‌زنه تا دور آواتار کاربر قاب رو نشون بده —
    // قبلاً activeFrame فقط نوشته می‌شد ولی هیچ‌جا برای نمایش خونده نمی‌شد.
    getOwnedFrameUrl() {
      const st = Adapters.getAppState();
      const frameId = st && st.profile && st.profile.activeFrame;
      if (!frameId) return null;
      const it = M.items.find((x) => x.id === frameId || (x.payload && x.payload.frameId === frameId));
      if (!it || it.type !== 'frame') return null;
      if (!isOwned(it.id)) return null;
      return it.fileUrl || null;
    },

    openDetail(itemId) {
      M.selectedItemId = itemId;
      M._detailModalOpen = true;
      M._detailReviews = [];
      M._detailReviewsLoaded = false;
      render();
      reviewsApi.loadForItem(itemId).then((list) => {
        M._detailReviews = list;
        M._detailReviewsLoaded = true;
        if (M._detailModalOpen && M.selectedItemId === itemId) render();
      });
    },
    closeDetail() { M._detailModalOpen = false; render(); },

    toggleFavorite(itemId) { favoritesApi.toggle(itemId); },

    submitReview(itemId) {
      const ratingEl = document.getElementById('market-review-rating');
      const textEl = document.getElementById('market-review-text');
      const rating = ratingEl ? parseInt(ratingEl.value, 10) : 5;
      const text = textEl ? textEl.value.trim() : '';
      reviewsApi.submit(itemId, rating, text).then((res) => {
        if (res.ok) {
          showToast('نظر شما ثبت شد');
          M._detailReviews.unshift(res.entry);
          render();
        }
      });
    },

    buy(itemId, method) {
      const it = M.items.find((x) => x.id === itemId);
      if (!it) return;
      if (!isPublished(it, Date.now())) { showToast(Adapters.t('marketComingSoon')); return; }
      if (!confirm(Adapters.t('marketConfirmPurchase'))) return;

      let resultPromise;
      if (method === 'free') resultPromise = purchaseFree(it);
      else if (method === 'coins') resultPromise = purchaseWithCoins(it);
      else resultPromise = purchaseWithToman(it);

      resultPromise.then((res) => {
        if (res && res.ok) {
          showToast(Adapters.t('marketPurchaseSuccess'));
          M._detailModalOpen = false;
          if (it.type === 'wordPack' || it.type === 'coinPack') activateItem(it);
          render();
        } else if (res && res.reason === 'already_owned') {
          showToast(Adapters.t('marketAlreadyOwned'));
        } else if (res && res.reason === 'insufficient_coins') {
          showToast(Adapters.t('marketNotEnoughCoins'));
        } else if (res && !res.redirected) {
          showToast('خطا در پرداخت. دوباره تلاش کن.');
        }
      });
    },

    activate(itemId) {
      const it = M.items.find((x) => x.id === itemId);
      if (it) activateItem(it);
    },

    redeemCoupon(codeInputEl) {
      const code = typeof codeInputEl === 'string' ? codeInputEl : (codeInputEl && codeInputEl.value) || '';
      couponApi.redeem(code).then((res) => {
        M.couponMsg = res.ok
          ? { ok: true, text: 'کد تخفیف «' + res.coupon.code + '» فعال شد ✓' }
          : { ok: false, text: res.reason === 'not_found' ? 'همچین کدی پیدا نشد' : res.reason === 'expired' ? 'این کد منقضی شده' : res.reason === 'exhausted' ? 'ظرفیت این کد تموم شده' : res.reason === 'offline' ? 'برای فعال‌سازی کد باید آنلاین باشی' : 'کد وارد نشد' };
        render();
      });
    },
    clearCoupon() { couponApi.clear(); M.couponMsg = null; render(); },

    redeemReferral(codeInputEl) {
      const code = typeof codeInputEl === 'string' ? codeInputEl : (codeInputEl && codeInputEl.value) || '';
      referralApi.redeem(code).then((res) => {
        M.referralMsg = res.ok
          ? { ok: true, text: `کد ثبت شد! ${REFERRAL_RULES.REFEREE_BONUS} سکه گرفتی 🎉` }
          : { ok: false, text: res.reason === 'self' ? 'این کدِ خودته' : res.reason === 'not_found' ? 'این کد پیدا نشد' : res.reason === 'already_used' ? 'قبلاً یه کد معرفی ثبت کردی' : res.reason === 'offline' ? 'برای ثبت کد باید آنلاین باشی' : 'کد وارد نشد' };
        render();
      });
    },

    buySubscription(planId) {
      if (!confirm(Adapters.t('marketConfirmPurchase'))) return;
      purchasePlan(planId).then((res) => {
        if (res && res.ok) showToast(Adapters.t('marketPurchaseSuccess'));
      });
    },
    cancelSub() { cancelSubscription(); },

    askAi() {
      const input = document.getElementById('market-ai-input');
      const answerBox = document.getElementById('market-ai-answer');
      if (!input || !answerBox) return;
      const q = input.value.trim();
      if (!q) return;
      answerBox.textContent = '...';
      AI.answerFAQ(q).then((ans) => { answerBox.className = 'market-ai-answer'; answerBox.textContent = ans; });
    },

    // برای هوک‌کردن به سیستم XP/هدف روزانه‌ی اپ اصلی:
    wallet: walletApi,
    favorites: favoritesApi,
    reviews: reviewsApi,
    ai: AI,

    // برای دیباگ/تست
    _internal: M,
  };

  function ensureRootMounted() {
    if (!root()) {
      const div = document.createElement('div');
      div.id = 'market-root';
      document.body.appendChild(div);
    }
  }

  global.Marketplace = Marketplace;
})(window);
