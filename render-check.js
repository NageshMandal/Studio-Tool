/**
 * Renders every page in the panel, once per role, against stubbed data.
 *
 * The point is to catch the class of bug a syntax check cannot see: a view
 * referencing a variable its controller never passes, a partial expecting a
 * field that got renamed, or a page that only breaks for one particular role.
 * Templates are compiled and executed for real; only the database is fake.
 */

const path = require('path');
const ejs = require('ejs');
const { icon } = require('./utils/icons');
const {
  formatWhen,
  formatTime,
  formatDuration,
  formatSince,
  formatDay,
} = require('./utils/format');

const VIEWS = path.join(__dirname, 'views');

const studio = {
  _id: 'studio1',
  name: 'Patna',
  code: 'PAT',
  city: 'Patna',
  theme: 'green',
  status: 'active',
  address: '12 Boring Road',
  phone: '0612 000 000',
  itemCount: 24,
  staffCount: 8,
  adminCount: 2,
};

const studios = [
  studio,
  { ...studio, _id: 'studio2', name: 'Ranchi', code: 'RAN', theme: 'blue' },
  { ...studio, _id: 'studio3', name: 'Kolkata', code: 'KOL', theme: 'purple' },
];

const person = { _id: 'u1', name: 'Rahul Kumar', email: 'rahul@office.com' };

const item = {
  _id: 'p1',
  name: 'Sony FX3',
  assetTag: 'PAT-0001',
  category: 'Camera',
  brand: 'Sony',
  model: 'FX3',
  condition: 'good',
  status: 'assigned',
  storageArea: 'Rack 2',
  price: 320000,
  imageUrl: null,
  occupiedAt: new Date(),
  occupyReason: 'Morning show',
  assignedTo: person,
  location: studio,
  createdAt: new Date(),
};

const log = {
  _id: 'l1',
  productName: 'Sony FX3',
  assetTag: 'PAT-0001',
  category: 'Camera',
  userName: 'Rahul Kumar',
  locationName: 'Patna',
  occupiedAt: new Date(),
  returnedAt: null,
  durationMinutes: null,
  reason: 'Morning show',
  imageUrl: null,
};

const purchase = {
  _id: 'pr1',
  reference: 'PAT-REQ-0001',
  itemName: 'Sennheiser MKE 600',
  category: 'Audio',
  quantity: 2,
  reason: 'The current shotgun mic picks up too much room noise on client shoots.',
  purchaseUrl: 'https://example.com/mic',
  estimatedPrice: 32000,
  urgency: 'high',
  neededBy: '2026-10-01',
  extraFields: [{ label: 'Mount', value: 'XLR' }],
  requestedBy: 'u1',
  requesterName: 'Aman Raj',
  requesterRole: 'sales',
  requesterDepartment: 'Sales',
  status: 'pending',
  createdAt: new Date(),
  decidedAt: null,
  decisionNote: null,
  linkedProduct: null,
};

const stats = {
  totalItems: 24, assignedItems: 6, availableItems: 14, maintenanceItems: 4,
  totalStaff: 8, takenToday: 5, returnedToday: 3,
  pendingRequests: 2, pendingBookings: 1, pendingTotal: 3,
  totalValue: 1250000, assignedPct: 25, availablePct: 58.3, maintenancePct: 16.7,
};

const report = {
  monthKey: '2026-09', monthLabel: 'September 2026',
  summary: { movements: 42, returns: 38, stillOut: 4, totalHours: 210.5, avgHours: 5.2, distinctItems: 12, activeStaff: 8, utilisation: 50 },
  inventory: { total: 24, value: 1250000, out: 6, maintenance: 4 },
  requests: { total: 9, approved: 7, rejected: 2 },
  bookings: { total: 5, confirmed: 4, declined: 1 },
  procurement: { total: 3, pending: 1, approved: 1, rejected: 0, received: 1, spend: 64000 },
  byPerson: [{ name: 'Rahul Kumar', movements: 12, hours: 40 }],
  byCategory: [{ category: 'Camera', movements: 20, hours: 90 }],
  byItem: [{ name: 'Sony FX3', assetTag: 'PAT-0001', movements: 8, hours: 30 }],
  daily: [{ day: '2026-09-01', count: 3, height: 60 }],
  logs: [log],
};

const ROLES = {
  super: { id: 'root', name: 'Studio Admin', email: 'admin@office.com', adminRole: 'super', isRoot: true, location: null },
  location_admin: { id: 'a1', name: 'Priya Sharma', email: 'priya@office.com', adminRole: 'location_admin', isRoot: false, location: 'studio1' },
  location_manager: { id: 'a2', name: 'Sujit Minz', email: 'sujit@office.com', adminRole: 'location_manager', isRoot: false, location: 'studio1' },
};

const { capabilities } = require('./middleware/auth');

function baseLocals(role, activeStudio) {
  const admin = ROLES[role];
  return {
    admin,
    can: capabilities(admin),
    activeStudio,
    studios,
    scope: { isSuper: role === 'super', activeId: activeStudio ? activeStudio._id : null, studios },
    active: '',
    title: 'Test page',
    message: null,
    error: null,
    pendingRequestCount: 3,
    pendingPurchaseCount: 2,
    icon,
    formatWhen, formatTime, formatDuration, formatSince, formatDay,
    formatDate: (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '—'),
    formatMoney: (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`,
  };
}

// view name -> the data its controller supplies
const PAGES = {
  dashboard: { studio, stats, outNow: [item], recent: [item], todayLogs: [log], openProcurement: 2, today: '2026-09-03' },
  'master-dashboard': {
    cards: studios.map((s) => ({ ...s, stats })),
    totals: { items: 72, assigned: 18, available: 42, staff: 24, pending: 9, value: 3750000 },
    rows: [log], staffList: [person], studios,
    query: { date: '', studio: '', status: '', staff: '' },
  },
  tracker: { rows: [log], staffList: [person], date: '2026-09-03', today: '2026-09-03', query: { staff: '', status: '' } },
  'studios/select': { studios },
  'studios/index': { studios },
  'studios/form': { studio: {}, themes: ['green', 'blue', 'purple'], formAction: '/admin/studios', isEdit: false, error: null },
  'products/index': {
    products: [item], categories: ['Camera', 'Lens'], statuses: ['available', 'assigned', 'maintenance'],
    conditions: ['new', 'good'], query: { q: '', category: '', status: '', condition: '' },
  },
  'products/form': {
    product: item, users: [person], categories: ['Camera'], conditions: ['new', 'good'],
    statuses: ['available'], studio, formAction: '/admin/products', isEdit: true, error: null, message: null,
  },
  'users/index': {
    users: [{ ...person, department: 'Studio', accountType: 'power', staffRole: 'sales', status: 'active', itemsHeld: 2, openPurchases: 1, designation: 'Operator', telegramChatId: '1' }],
    departments: ['Client Servicing', 'Post Production', 'Sales', 'Studio'], staffRoles: ['staff', 'sales'],
    query: { q: '', department: '', status: '', staffRole: '' },
  },
  'users/form': {
    user: { ...person, department: 'Post Production' },
    departments: ['Client Servicing', 'Post Production', 'Studio'], staffRoles: ['staff', 'sales'], studio,
    formAction: '/admin/users', isEdit: false, error: null,
  },
  'requests/index': {
    pending: [{ _id: 'r1', productName: 'Sony FX3', assetTag: 'PAT-0001', userName: 'Rahul', reason: 'Shoot', createdAt: new Date() }],
    decided: [{ _id: 'r2', productName: 'Lens', assetTag: 'PAT-0002', userName: 'Priya', status: 'approved', decidedBy: 'admin', decidedAt: new Date() }],
    pendingBookings: [{ _id: 'b1', productName: 'Mic', assetTag: 'PAT-0003', userName: 'Aman', bookedFor: '2026-09-10', reason: 'Client' }],
    upcomingBookings: [{ _id: 'b2', productName: 'Tripod', assetTag: 'PAT-0004', userName: 'Neha', bookedFor: '2026-09-12' }],
    waitingClaims: [{ productName: 'Light', userName: 'Rohit', holderName: 'Rahul' }],
  },
  'procurement/index': {
    requests: [purchase],
    counts: { pending: 1, approved: 1, ordered: 0, received: 1, rejected: 0, all: 3 },
    statuses: ['pending', 'approved', 'ordered', 'received', 'rejected', 'cancelled'],
    statusLabels: { pending: 'Waiting on admin', approved: 'Approved', ordered: 'Ordered', received: 'Received', rejected: 'Rejected', cancelled: 'Cancelled' },
    urgencies: ['low', 'normal', 'high', 'urgent'],
    query: { status: '', urgency: '', q: '' },
  },
  'procurement/detail': {
    request: purchase,
    requester: { ...person, department: 'Sales', designation: 'Executive', staffRole: 'sales', phone: '900000' },
    statusLabels: { pending: 'Waiting on admin', approved: 'Approved', ordered: 'Ordered', received: 'Received', rejected: 'Rejected', cancelled: 'Cancelled' },
    categories: ['Audio'],
  },
  'reports/monthly': {
    studio, report, prevMonth: '2026-08', nextMonth: '2026-10', thisMonth: '2026-09',
    canCompare: true, studios,
  },
  'reports/compare': {
    reports: studios.map((s) => ({ studio: s, report, barWidth: 70 })),
    totals: { movements: 126, hours: 631.5, items: 72, staff: 24, value: 3750000 },
    monthKey: '2026-09', monthLabelText: 'September 2026',
    prevMonth: '2026-08', nextMonth: '2026-10', thisMonth: '2026-09',
  },
  'logs/index': {
    logs: [log], staffList: [person], date: '2026-09-03', isToday: true,
    prevDate: '2026-09-02', nextDate: '2026-09-04', maxDate: '2026-09-03',
    query: { q: '', staff: '' },
    summary: { startedToday: 5, returnedToday: 3, stillOut: 2, totalHours: 12.5, busiest: { name: 'Rahul', count: 3 } },
  },
  'admins/index': {
    admins: [{ _id: 'a1', name: 'Priya Sharma', email: 'priya@office.com', role: 'location_admin', location: studio, status: 'active', canManage: true, isMe: false, createdBy: 'admin@office.com', lastLoginAt: new Date() }],
    studios, roleLabels: { super: 'Super admin', location_admin: 'Location admin', location_manager: 'Location manager' },
    canAdd: true, root: { name: 'Studio Admin', email: 'admin@office.com', isMe: true }, showRoot: true,
  },
  'admins/form': {
    account: {}, roles: ['super', 'location_admin', 'location_manager'],
    roleLabels: { super: 'Super admin', location_admin: 'Location admin', location_manager: 'Location manager' },
    studios, lockedLocation: null, error: null,
  },
  settings: { studio },
  error: { code: 404, message: 'Not found' },
  login: { error: null, email: '', role: '', roles: [{ value: '', label: 'Auto detect' }, { value: 'admin', label: 'Administrator' }] },
};

// The staff portal has its own layout and locals
const STAFF_PAGES = {
  'staff/dashboard': {
    user: { ...person, accountType: 'power', location: studio },
    alerts: [{ _id: 'n1', title: 'Request declined', productName: 'Lens', assetTag: 'PAT-0002', note: 'Already booked', createdAt: new Date() }],
    pastAlerts: [],
    myItems: [item], myRequests: [{ _id: 'r1', productName: 'Mic', assetTag: 'PAT-0003', createdAt: new Date() }],
    myBookings: [{ _id: 'b1', productName: 'Tripod', bookedFor: '2026-09-10', pickupTime: '10:00', status: 'confirmed' }],
    myClaims: [{ _id: 'c1', productName: 'Light', holderName: 'Rohit' }],
    myPurchases: [purchase],
    awaitingByProduct: {}, claimByProduct: {},
  },
  'staff/inventory': {
    user: { ...person, accountType: 'power', location: studio },
    groups: [{ category: 'Camera', items: [{ ...item, assignedTo: null, status: 'available' }] }],
    holderMap: {}, pendingByProduct: {}, claimByProduct: {}, bookedTodayByProduct: {},
    categories: ['Camera'], statuses: ['available'], query: { q: '', category: '', status: '' },
    todayKey: '2026-09-03',
  },
  'staff/purchase-requests': {
    user: { ...person, location: studio }, requests: [purchase],
    categories: ['Audio', 'Camera'], urgencies: ['low', 'normal', 'high', 'urgent'],
    statusLabels: { pending: 'Waiting on admin', approved: 'Approved', ordered: 'Ordered', received: 'Received', rejected: 'Rejected', cancelled: 'Cancelled' },
    today: '2026-09-03',
  },
};

let failures = 0;

function render(view, locals, label) {
  return new Promise((resolve) => {
    ejs.renderFile(path.join(VIEWS, view + '.ejs'), locals, { views: [VIEWS] }, (err) => {
      if (err) {
        failures++;
        console.log(`FAIL  ${label}`);
        console.log(`      ${String(err.message).split('\n').filter(Boolean).slice(-1)[0].trim()}`);
      } else {
        console.log(`PASS  ${label}`);
      }
      resolve();
    });
  });
}

(async () => {
  console.log('\n--- Admin pages, per role ---');
  for (const role of ['super', 'location_admin', 'location_manager']) {
    // A super admin without a chosen studio still has to render the master view
    const active = role === 'super' ? studio : studio;
    for (const [view, data] of Object.entries(PAGES)) {
      const locals = { ...baseLocals(role, active), ...data };
      await render(view, locals, `${role.padEnd(17)} ${view}`);
    }
  }

  console.log('\n--- Super admin with no studio selected ---');
  for (const view of ['master-dashboard', 'studios/select', 'studios/index']) {
    const locals = { ...baseLocals('super', null), ...PAGES[view] };
    await render(view, locals, `super (all studios)  ${view}`);
  }

  console.log('\n--- Staff portal ---');
  for (const [view, data] of Object.entries(STAFF_PAGES)) {
    const locals = {
      staff: { ...person, accountType: 'power' },
      studio,
      unreadAlertCount: 2,
      active: '',
      title: 'Staff',
      message: null,
      error: null,
      icon,
      formatWhen, formatTime, formatDuration, formatSince, formatDay,
      formatDate: (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '—'),
      formatMoney: (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`,
      ...data,
    };
    await render(view, locals, `staff             ${view}`);
  }

  console.log(failures ? `\n${failures} page(s) failed to render` : '\nEVERY PAGE RENDERED CLEANLY');
  process.exit(failures ? 1 : 0);
})();
