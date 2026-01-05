import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  Paper,
  Typography,
  Grid,
  Card,
  CardContent,
  LinearProgress,
  Alert,
  TextField,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Divider,
  TablePagination,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  CircularProgress,
} from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Stop as StopIcon,
  Pause as PauseIcon,
  Speed as SpeedIcon,
  Upload as UploadIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Phone as PhoneIcon,
  Refresh as RefreshIcon,
  Sync as SyncIcon,
  CheckCircle as CheckCircleIcon,
  Voicemail as VoicemailIcon,
  PhoneMissed as PhoneMissedIcon,
  ErrorOutline as ErrorOutlineIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { useDropzone } from 'react-dropzone';
import { agentAPI, usersAPI, callsAPI, didAPI } from '../services/api';
import UserEditDialog from './UserEditDialog';
import UserManagement from './UserManagement';

function AgentControl({ wsConnection }) {
  const [agentStatus, setAgentStatus] = useState({
    status: 'stopped',
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    qualifiedLeads: 0,
    disqualifiedLeads: 0,
    queueLength: 0,
  });
  const [pendingUsers, setPendingUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [delayBetweenCalls, setDelayBetweenCalls] = useState(5);
  const [transferNumber, setTransferNumber] = useState('+18434028556');
  const [maxConcurrentCalls, setMaxConcurrentCalls] = useState(1);
  const [alert, setAlert] = useState(null);
  const [didRotation, setDidRotation] = useState({
    enabled: false,
    allNumbers: [],
    numbersByState: {},
    strategy: 'area_code',
  });
  const [refreshingDID, setRefreshingDID] = useState(false);
  const [userDIDMatches, setUserDIDMatches] = useState({});
  const [answerStats, setAnswerStats] = useState({
    total: 0,
    answered: 0,
    voicemail: 0,
    no_answer: 0,
    not_found: 0,
    pending: 0,
    answerRate: '0%'
  });
  const [costStats, setCostStats] = useState({
    totalCost: 0,
    telnyxCost: 0,
    elevenlabsCost: 0,      // NEW
    openaiCost: 0,
    avgCostPerCall: 0,
    avgCostPerMinute: 0,
    breakdown: {}
  });
  const [transferredCalls, setTransferredCalls] = useState([]);
  
  // User management states
  const [openDialog, setOpenDialog] = useState(false);
  const [openCSVDialog, setOpenCSVDialog] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    firstname: '',
    lastname: '',
    phone: '',
    address: '',
    email: '',
    notes: '',
  });

  // Pagination and filtering state
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [totalUsers, setTotalUsers] = useState(0);
  const [searchInput, setSearchInput] = useState(''); // User's immediate input
  const [search, setSearch] = useState(''); // Debounced search value for API
  const [statusFilter, setStatusFilter] = useState('');
  const [answerTypeFilter, setAnswerTypeFilter] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Helper function for calculating DID matches - defined before fetchAllUsers
  const calculateBestMatches = useCallback(async (users) => {
    if (!didRotation.enabled || users.length === 0) return;
    
    const matches = {};
    for (const user of users) {
      try {
        const matchResponse = await didAPI.matchDID(user.phone, user.state);
        matches[user.id] = {
          number: matchResponse.data.data.number,
          matchType: matchResponse.data.data.matchType,
          recipientAreaCode: matchResponse.data.data.recipientAreaCode,
        };
      } catch (error) {
        matches[user.id] = null;
      }
    }
    setUserDIDMatches(matches);
  }, [didRotation.enabled]);

  // Define fetchAllUsers before useEffect hooks that use it
  const fetchAllUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const response = await usersAPI.getPaginated(
        page + 1, // API uses 1-based pagination
        rowsPerPage,
        {
          search,
          status: statusFilter,
          answerType: answerTypeFilter
        }
      );
      const users = response.data.data;
      setAllUsers(users);
      setTotalUsers(response.data.pagination.total);
      
      // Calculate best-matched DID for each user (only for current page)
      await calculateBestMatches(users);
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoadingUsers(false);
    }
  }, [page, rowsPerPage, search, statusFilter, answerTypeFilter, calculateBestMatches]);

  useEffect(() => {
    fetchStatus();
    fetchPendingUsers();
    fetchAllUsers();
    fetchDIDRotation();
    fetchInitialConfig(); // Load transfer number once on mount
    fetchAnswerStats(); // Load answer statistics
    fetchTransferredCalls(); // Load transferred calls
    
    // Optimized polling - only fetch stats and status, not all users
    const interval = setInterval(() => {
      fetchStatus();
      fetchAnswerStats(); // Refresh answer stats
      fetchTransferredCalls(); // Refresh transferred calls
      fetchPendingUsers(); // Update pending count
    }, 2000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Separate effect for fetching users when pagination/filters change
  useEffect(() => {
    fetchAllUsers();
  }, [fetchAllUsers]);

  useEffect(() => {
    if (!wsConnection) return;

    wsConnection.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'call_event') {
        fetchStatus();
      }
    };
  }, [wsConnection]);

  const fetchStatus = async () => {
    try {
      const response = await agentAPI.getStatus();
      
      const data = response.data.data;
      setAgentStatus(data);
      
      // Update cost stats if available
      if (data && data.costs) {
        setCostStats({
          totalCost: data.costs.totalCost || 0,
          telnyxCost: data.costs.telnyxCost || 0,
          elevenlabsCost: data.costs.elevenlabsTotal || 0,    // NEW
          openaiCost: data.costs.openaiCost || 0,
          avgCostPerCall: data.costs.avgCostPerCall || 0,
          avgCostPerMinute: data.costs.avgCostPerMinute || 0,
          breakdown: data.costs.breakdown || {}
        });
      } else {
        console.warn('⚠️  No costs in API response');
        if (data) {
          console.log('   data keys:', Object.keys(data));
        }
      }
      // Don't update transfer number here - it's updated only on initial load and after save
      // This prevents the field from being reset while user is typing
    } catch (error) {
      console.error('Error fetching agent status:', error);
    }
  };

  // Fetch transfer number only once on initial load
  const fetchInitialConfig = async () => {
    try {
      const response = await agentAPI.getConfig();
      const data = response.data.data;
      if (data.transferNumber) {
        setTransferNumber(data.transferNumber);
      }
      if (data.maxConcurrentCalls) {
        setMaxConcurrentCalls(data.maxConcurrentCalls);
      }
    } catch (error) {
      console.error('Error fetching initial config:', error);
    }
  };

  const fetchPendingUsers = async () => {
    try {
      const response = await usersAPI.getPending();
      setPendingUsers(response.data.data);
    } catch (error) {
      console.error('Error fetching pending users:', error);
    }
  };

  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleSearchChange = (event) => {
    setSearchInput(event.target.value);
  };

  // Debounce search input - wait 500ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 500);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchAnswerStats = async () => {
    try {
      const response = await usersAPI.getAnswerStats();
      if (response.data.success) {
        setAnswerStats(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching answer stats:', error);
    }
  };

  const fetchTransferredCalls = async () => {
    try {
      const response = await agentAPI.getTransferredCalls();
      if (response.data.success) {
        setTransferredCalls(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching transferred calls:', error);
    }
  };

  // User management functions
  const handleOpenDialog = (user = null) => {
    if (user) {
      setEditingUser(user);
      setFormData(user);
    } else {
      setEditingUser(null);
      setFormData({
        firstname: '',
        lastname: '',
        phone: '',
        address: '',
        email: '',
        notes: '',
      });
    }
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setEditingUser(null);
  };

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async () => {
    try {
      if (editingUser) {
        await usersAPI.update(editingUser.id, formData);
        showAlert('success', 'User updated successfully');
      } else {
        await usersAPI.create(formData);
        showAlert('success', 'User created successfully');
      }
      handleCloseDialog();
      fetchAllUsers();
    } catch (error) {
      showAlert('error', 'Failed to save user');
    }
  };

  const handleDelete = async (userId) => {
    if (window.confirm('Are you sure you want to delete this user?')) {
      try {
        await usersAPI.delete(userId);
        showAlert('success', 'User deleted successfully');
        fetchAllUsers();
      } catch (error) {
        showAlert('error', 'Failed to delete user');
      }
    }
  };

  const handleCSVUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await usersAPI.importCSV(formData);
      showAlert('success', `Imported ${response.data.data.count} users successfully`);
      setOpenCSVDialog(false);
      fetchAllUsers();
    } catch (error) {
      showAlert('error', 'Failed to import CSV');
    }
  };

  const handleCall = async (user) => {
    try {
      // Get matched DID based on user's area code
      let fromNumber;
      try {
        const matchResponse = await didAPI.matchDID(user.phone, user.state);
        fromNumber = matchResponse.data.data.number;
        console.log(`📍 Matched DID for ${user.phone}: ${fromNumber} (${matchResponse.data.data.matchType})`);
      } catch (error) {
        // Fallback to next available
        const numbersResponse = await didAPI.getPurchased();
        if (numbersResponse.data.data.length === 0) {
          showAlert('error', 'No phone numbers available');
          return;
        }
        fromNumber = numbersResponse.data.data[0].phone_number;
      }
      await callsAPI.initiate(user.id, fromNumber);
      showAlert('success', `Calling ${user.firstname} ${user.lastname} from ${fromNumber}`);
      fetchAllUsers(); // Refresh to show new DID
    } catch (error) {
      showAlert('error', 'Failed to initiate call');
    }
  };

  const handleResetStatus = async (user) => {
    if (window.confirm(`Reset ${user.firstname} ${user.lastname} to "pending" status? This will allow them to be called again.`)) {
      try {
        await usersAPI.update(user.id, { ...user, status: 'pending', didNumber: null });
        showAlert('success', `${user.firstname} ${user.lastname} reset to pending`);
        fetchAllUsers();
      } catch (error) {
        showAlert('error', 'Failed to reset user status');
      }
    }
  };

  const onDrop = async (acceptedFiles) => {
    const file = acceptedFiles[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await usersAPI.import(formData);
      showAlert('success', `Imported ${response.data.data.length} users successfully`);
      fetchAllUsers();
    } catch (error) {
      showAlert('error', 'Failed to import CSV');
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
    },
    multiple: false,
  });

  const fetchDIDRotation = async () => {
    try {
      const response = await didAPI.getRotation();
      if (response.data.success) {
        setDidRotation(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching DID rotation:', error);
    }
  };

  const handleRefreshDID = async () => {
    setRefreshingDID(true);
    try {
      // Trigger backend to reload DIDs from Telnyx
      const response = await didAPI.getPurchased();
      const numbers = response.data.data.map(n => n.phone_number);
      
      if (numbers.length === 0) {
        showAlert('warning', 'No phone numbers found in Telnyx. Please purchase DIDs first.');
        setRefreshingDID(false);
        return;
      }

      // Reconfigure rotation with all numbers
      await didAPI.configureRotation(numbers, true, 'area_code');
      
      // Fetch updated rotation
      await fetchDIDRotation();
      
      showAlert('success', `✅ DID Rotation refreshed! Loaded ${numbers.length} numbers`);
    } catch (error) {
      showAlert('error', 'Failed to refresh DID rotation');
    } finally {
      setRefreshingDID(false);
    }
  };

  const handleSaveConfig = async () => {
    console.log('📞 Saving config:', { transferNumber, maxConcurrentCalls });
    try {
      const response = await agentAPI.updateConfig({ 
        transferNumber, 
        maxConcurrentCalls 
      });
      console.log('✅ Config saved:', response.data);
      showAlert('success', `✅ Settings Saved! Transfer: ${transferNumber}, Concurrent: ${maxConcurrentCalls}`);
    } catch (error) {
      console.error('❌ Error saving config:', error);
      console.error('   Response:', error.response?.data);
      showAlert('error', error.response?.data?.error || 'Failed to save settings');
    }
  };

  const handleStart = async () => {
    try {
      if (pendingUsers.length === 0) {
        showAlert('warning', 'No pending users to call. Please upload users first.');
        return;
      }
      // Start agent with all pending users (no selection needed)
      await agentAPI.start(undefined, delayBetweenCalls * 1000);
      showAlert('success', `AI Agent started! Calling ${pendingUsers.length} users with smart DID matching`);
      fetchStatus();
      fetchPendingUsers(); // Refresh list
    } catch (error) {
      showAlert('error', error.response?.data?.error || 'Failed to start agent');
    }
  };

  const handleStop = async () => {
    try {
      await agentAPI.stop();
      showAlert('success', 'AI Agent stopped');
      fetchStatus();
    } catch (error) {
      showAlert('error', 'Failed to stop agent');
    }
  };

  const handlePause = async () => {
    try {
      await agentAPI.pause();
      showAlert('success', 'AI Agent paused');
      fetchStatus();
    } catch (error) {
      showAlert('error', 'Failed to pause agent');
    }
  };

  const handleResume = async () => {
    try {
      await agentAPI.resume();
      showAlert('success', 'AI Agent resumed');
      fetchStatus();
    } catch (error) {
      showAlert('error', 'Failed to resume agent');
    }
  };

  const handleClearTransferredCalls = async () => {
    try {
      await agentAPI.clearTransferredCalls();
      setTransferredCalls([]);
      showAlert('success', 'Transferred calls list cleared');
    } catch (error) {
      console.error('Error clearing transferred calls:', error);
      showAlert('error', 'Failed to clear transferred calls');
    }
  };

  const showAlert = (severity, message) => {
    setAlert({ severity, message });
    setTimeout(() => setAlert(null), 5000);
  };

  const getAgentStatusColor = (status) => {
    switch (status) {
      case 'running':
        return 'success';
      case 'paused':
        return 'warning';
      case 'stopped':
        return 'default';
      default:
        return 'default';
    }
  };

  const getUserStatusColor = (status) => {
    switch (status) {
      case 'pending':
        return 'default';
      case 'called':
        return 'primary';
      case 'qualified':
        return 'success';
      case 'disqualified':
        return 'error';
      default:
        return 'default';
    }
  };

  const getAnswerTypeColor = (answerType) => {
    switch (answerType) {
      case 'answered':
        return 'success';
      case 'voicemail':
        return 'warning';
      case 'no_answer':
        return 'default';
      case 'not_found':
        return 'error';
      case 'busy':
        return 'warning';
      default:
        return 'default';
    }
  };

  const getAnswerTypeIcon = (answerType) => {
    switch (answerType) {
      case 'answered':
        return <CheckCircleIcon fontSize="small" />;
      case 'voicemail':
        return <VoicemailIcon fontSize="small" />;
      case 'no_answer':
      case 'busy':
        return <PhoneMissedIcon fontSize="small" />;
      case 'not_found':
        return <ErrorOutlineIcon fontSize="small" />;
      default:
        return null;
    }
  };

  const calculateProgress = () => {
    if (agentStatus.totalCalls === 0) return 0;
    const total = agentStatus.totalCalls + agentStatus.queueLength;
    return (agentStatus.totalCalls / total) * 100;
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        🤖 AI Agent Control Center
      </Typography>

      {alert && (
        <Alert 
          severity={alert.severity} 
          sx={{ 
            mb: 3, 
            fontSize: '1.1rem',
            fontWeight: 'bold',
            boxShadow: 3,
            animation: 'slideDown 0.3s ease-out',
            '@keyframes slideDown': {
              from: { transform: 'translateY(-20px)', opacity: 0 },
              to: { transform: 'translateY(0)', opacity: 1 }
            }
          }} 
          onClose={() => setAlert(null)}
        >
          {alert.message}
        </Alert>
      )}

      {/* Qualified & Transferred Calls Section */}
      {transferredCalls.length > 0 && (
        <Paper sx={{ p: 3, mb: 3, bgcolor: '#e8f5e9', border: '2px solid #4caf50' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h5" sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#2e7d32' }}>
              ✅ Qualified & Transferred Calls ({transferredCalls.length})
            </Typography>
            <Button
              variant="outlined"
              size="small"
              color="error"
              onClick={handleClearTransferredCalls}
              sx={{ minWidth: '100px' }}
            >
              Clear List
            </Button>
          </Box>
          
          <TableContainer sx={{ bgcolor: 'white', borderRadius: 1 }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: '#c8e6c9' }}>
                  <TableCell sx={{ fontWeight: 'bold' }}>Name</TableCell>
                  <TableCell sx={{ fontWeight: 'bold' }}>Phone</TableCell>
                  <TableCell sx={{ fontWeight: 'bold' }}>Address</TableCell>
                  <TableCell sx={{ fontWeight: 'bold' }}>Transferred To</TableCell>
                  <TableCell sx={{ fontWeight: 'bold' }}>Time</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {transferredCalls.slice().reverse().map((call) => (
                  <TableRow key={call.id} sx={{ '&:hover': { bgcolor: '#f1f8e9' } }}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#2e7d32' }}>
                        {call.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip 
                        label={call.phone} 
                        size="small" 
                        sx={{ bgcolor: '#4caf50', color: 'white', fontWeight: 'bold' }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="textSecondary">
                        {call.address}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="textSecondary">
                        {call.toNumber}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="textSecondary">
                        {new Date(call.timestamp).toLocaleTimeString()}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      {/* Agent Control Section - MOVED TO TOP */}
      <Typography variant="h5" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        🚀 AI Agent Controls
      </Typography>

      <Grid container spacing={3}>
        {/* Status Card */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="h6">Agent Status</Typography>
                <Chip
                  label={agentStatus.status.toUpperCase()}
                  color={getAgentStatusColor(agentStatus.status)}
                  size="large"
                />
              </Box>

              {agentStatus.status === 'running' && (
                <Box sx={{ mt: 2 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="body2">Progress</Typography>
                    <Typography variant="body2">
                      {agentStatus.totalCalls} / {agentStatus.totalCalls + agentStatus.queueLength} calls
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={calculateProgress()}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Statistics */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                Total Calls
              </Typography>
              <Typography variant="h4">{agentStatus.totalCalls}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Card sx={{ bgcolor: agentStatus.activeCalls > 0 ? '#e3f2fd' : 'white' }}>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                Active Now
              </Typography>
              <Typography variant="h4" color={agentStatus.activeCalls > 0 ? 'primary.main' : 'text.primary'}>
                {agentStatus.activeCalls || 0} / {maxConcurrentCalls}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                Successful
              </Typography>
              <Typography variant="h4" color="success.main">
                {agentStatus.successfulCalls}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                Qualified Leads
              </Typography>
              <Typography variant="h4" color="primary.main">
                {agentStatus.qualifiedLeads}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                In Queue
              </Typography>
              <Typography variant="h4">{agentStatus.queueLength}</Typography>
            </CardContent>
          </Card>
        </Grid>

        {/* Answer Statistics Section */}
        <Grid item xs={12}>
          {/* Cost Tracking Stats */}
          <Paper sx={{ p: 3, bgcolor: '#fff8e1', mb: 3 }}>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              💰 Cost Analysis
            </Typography>
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={6} sm={2.4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#ffffff', borderRadius: 1, border: '2px solid #fbc02d' }}>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
                    Total Cost
                  </Typography>
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#f57c00' }}>
                    ${(costStats.totalCost || 0).toFixed(2)}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={2.4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#ffffff', borderRadius: 1 }}>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
                    Telnyx
                  </Typography>
                  <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#1976d2' }}>
                    ${(costStats.telnyxCost || 0).toFixed(2)}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={2.4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#ffffff', borderRadius: 1 }}>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
                    ElevenLabs
                  </Typography>
                  <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#9c27b0' }}>
                    ${(costStats.elevenlabsCost || 0).toFixed(2)}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={2.4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#ffffff', borderRadius: 1 }}>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
                    OpenAI
                  </Typography>
                  <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#00796b' }}>
                    ${(costStats.openaiCost || 0).toFixed(2)}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={2.4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#ffffff', borderRadius: 1 }}>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
                    Avg/Call
                  </Typography>
                  <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#7b1fa2' }}>
                    ${(costStats.avgCostPerCall || 0).toFixed(2)}
                  </Typography>
                  <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 0.5, fontSize: '0.65rem' }}>
                    Successful calls only
                  </Typography>
                </Box>
              </Grid>
            </Grid>
            <Box sx={{ mt: 2, p: 2, bgcolor: '#ffffff', borderRadius: 1 }}>
              <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
                <strong>Detailed Breakdown:</strong>
              </Typography>
              <Grid container spacing={1}>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="textSecondary">
                    Telnyx Calls: ${(costStats.breakdown.callCost || 0).toFixed(2)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="textSecondary">
                    Telnyx Streaming: ${(costStats.breakdown.streamingCost || 0).toFixed(2)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="textSecondary">
                    Transfers: ${(costStats.breakdown.transferCost || 0).toFixed(2)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="textSecondary">
                    ElevenLabs TTS: ${(costStats.breakdown.elevenlabsTTS || 0).toFixed(2)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="textSecondary">
                    ElevenLabs STT: ${(costStats.breakdown.elevenlabsSTT || 0).toFixed(2)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="textSecondary">
                    AI Processing: ${(costStats.breakdown.openaiCost || 0).toFixed(2)}
                  </Typography>
                </Grid>
              </Grid>
            </Box>
          </Paper>

          <Paper sx={{ p: 3, bgcolor: '#f0f7ff' }}>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              📊 Answer Rate Statistics
            </Typography>
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={6} sm={4} md={2}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#e8f5e9', borderRadius: 1 }}>
                  <CheckCircleIcon sx={{ fontSize: 32, color: '#4caf50', mb: 1 }} />
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#4caf50' }}>
                    {answerStats.answered}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Real Answers
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#fff3e0', borderRadius: 1 }}>
                  <VoicemailIcon sx={{ fontSize: 32, color: '#ff9800', mb: 1 }} />
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#ff9800' }}>
                    {answerStats.voicemail}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Voicemail
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#fce4ec', borderRadius: 1 }}>
                  <PhoneMissedIcon sx={{ fontSize: 32, color: '#e91e63', mb: 1 }} />
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#e91e63' }}>
                    {answerStats.no_answer}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    No Answer
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#ffebee', borderRadius: 1 }}>
                  <ErrorOutlineIcon sx={{ fontSize: 32, color: '#f44336', mb: 1 }} />
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#f44336' }}>
                    {answerStats.not_found}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Not Found
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#e3f2fd', borderRadius: 1 }}>
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#1976d2' }}>
                    {answerStats.pending}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Pending
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#fff', borderRadius: 1, border: '2px solid #4caf50' }}>
                  <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#4caf50' }}>
                    {answerStats.answerRate}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Answer Rate
                  </Typography>
                </Box>
              </Grid>
            </Grid>
          </Paper>
        </Grid>

        {/* Control Panel */}
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Control Panel
            </Typography>

            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={12}>
                <Alert severity="info" sx={{ mb: 2 }}>
                  <Typography variant="body2">
                    📍 <strong>Smart DID Matching Enabled</strong><br />
                    The agent will automatically call all pending users and match DIDs by area code/state for maximum answer rates.
                  </Typography>
                </Alert>
              </Grid>

              <Grid item xs={12} md={6}>
                <TextField
                  label="Delay Between Calls (seconds)"
                  type="number"
                  value={delayBetweenCalls}
                  onChange={(e) => setDelayBetweenCalls(Math.max(1, parseInt(e.target.value) || 1))}
                  disabled={agentStatus.status !== 'stopped'}
                  fullWidth
                  InputProps={{
                    startAdornment: <SpeedIcon sx={{ mr: 1, color: 'text.secondary' }} />,
                  }}
                  helperText="Delay between each call to avoid rate limiting"
                />
              </Grid>

              <Grid item xs={12} md={6}>
                <TextField
                  label="Human Agent Transfer Number"
                  type="tel"
                  value={transferNumber}
                  onChange={(e) => setTransferNumber(e.target.value)}
                  disabled={agentStatus.status !== 'stopped'}
                  fullWidth
                  InputProps={{
                    startAdornment: <PhoneIcon sx={{ mr: 1, color: 'text.secondary' }} />,
                  }}
                  helperText="Phone number for qualified lead transfers (e.g., +18434028556)"
                  placeholder="+1XXXXXXXXXX"
                />
              </Grid>

              <Grid item xs={12} md={6}>
                <TextField
                  label="Max Concurrent Calls"
                  type="number"
                  value={maxConcurrentCalls}
                  onChange={(e) => setMaxConcurrentCalls(parseInt(e.target.value) || 1)}
                  disabled={agentStatus.status !== 'stopped'}
                  fullWidth
                  inputProps={{
                    min: 1,
                    max: 50,
                    step: 1
                  }}
                  InputProps={{
                    startAdornment: <SpeedIcon sx={{ mr: 1, color: 'text.secondary' }} />,
                  }}
                  helperText="Number of simultaneous calls (1-50). Higher = faster but more resources."
                />
              </Grid>

              <Grid item xs={12}>
                <Button
                  variant="outlined"
                  color="primary"
                  onClick={handleSaveConfig}
                  disabled={agentStatus.status !== 'stopped'}
                  startIcon={<PhoneIcon />}
                >
                  Save Configuration
                </Button>
              </Grid>

              <Grid item xs={12} md={6}>
                <Box
                  sx={{
                    p: 2,
                    bgcolor: 'background.paper',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                  }}
                >
                  <Typography variant="body2" color="textSecondary" gutterBottom>
                    Ready to Call
                  </Typography>
                  <Typography variant="h3" color="primary">
                    {pendingUsers.length}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    pending users
                  </Typography>
                </Box>
              </Grid>

              <Grid item xs={12}>
                <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
                  {agentStatus.status === 'stopped' && (
                    <Button
                      variant="contained"
                      color="success"
                      size="large"
                      startIcon={<PlayIcon />}
                      onClick={handleStart}
                      fullWidth
                    >
                      Start Agent
                    </Button>
                  )}

                  {agentStatus.status === 'running' && (
                    <>
                      <Button
                        variant="contained"
                        color="warning"
                        size="large"
                        startIcon={<PauseIcon />}
                        onClick={handlePause}
                        fullWidth
                      >
                        Pause
                      </Button>
                      <Button
                        variant="contained"
                        color="error"
                        size="large"
                        startIcon={<StopIcon />}
                        onClick={handleStop}
                        fullWidth
                      >
                        Stop
                      </Button>
                    </>
                  )}

                  {agentStatus.status === 'paused' && (
                    <>
                      <Button
                        variant="contained"
                        color="success"
                        size="large"
                        startIcon={<PlayIcon />}
                        onClick={handleResume}
                        fullWidth
                      >
                        Resume
                      </Button>
                      <Button
                        variant="contained"
                        color="error"
                        size="large"
                        startIcon={<StopIcon />}
                        onClick={handleStop}
                        fullWidth
                      >
                        Stop
                      </Button>
                    </>
                  )}
                </Box>
              </Grid>
            </Grid>
          </Paper>
        </Grid>

        {/* Pending Users Summary */}
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              📋 Call Queue Summary
            </Typography>
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={12} md={4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#e3f2fd', borderRadius: 1 }}>
                  <Typography variant="h4" color="primary">
                    {pendingUsers.length}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Pending Users
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={12} md={4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#e8f5e9', borderRadius: 1 }}>
                  <Typography variant="h4" color="success.main">
                    {agentStatus.queueLength}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    In Queue
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={12} md={4}>
                <Box sx={{ textAlign: 'center', p: 2, bgcolor: '#fff3e0', borderRadius: 1 }}>
                  <Typography variant="h4" sx={{ color: '#ff9800' }}>
                    {Math.ceil((pendingUsers.length * delayBetweenCalls) / 60)}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    Est. Minutes
                  </Typography>
                </Box>
              </Grid>
            </Grid>
            <Alert severity="success" sx={{ mt: 2 }}>
              <Typography variant="body2">
                ✅ <strong>Automated Calling:</strong> Click "Start Agent" to automatically process all pending users with intelligent DID rotation by area code/state.
              </Typography>
            </Alert>
          </Paper>
        </Grid>
      </Grid>

      <Divider sx={{ my: 4 }} />

      {/* User Management Section */}
      <UserManagement />

      {/* DID Rotation Status */}
      <Paper sx={{ p: 3, mb: 3, bgcolor: '#f5f5f5' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <SyncIcon /> DID Rotation Status
            </Typography>
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item>
                <Typography variant="body2" color="textSecondary">
                  Strategy:
                </Typography>
                <Chip 
                  label={didRotation.strategy === 'area_code' ? 'Area Code Match' : 'Round Robin'} 
                  size="small" 
                  color="primary"
                  sx={{ mt: 0.5 }}
                />
              </Grid>
              <Grid item>
                <Typography variant="body2" color="textSecondary">
                  Total DIDs:
                </Typography>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#1976d2' }}>
                  {didRotation.allNumbers?.length || 0}
                </Typography>
              </Grid>
              <Grid item>
                <Typography variant="body2" color="textSecondary">
                  States Covered:
                </Typography>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#4caf50' }}>
                  {Object.keys(didRotation.numbersByState || {}).length}
                </Typography>
              </Grid>
              <Grid item>
                <Typography variant="body2" color="textSecondary">
                  Status:
                </Typography>
                <Chip 
                  label={didRotation.enabled ? 'Enabled' : 'Disabled'} 
                  size="small" 
                  color={didRotation.enabled ? 'success' : 'default'}
                  sx={{ mt: 0.5 }}
                />
              </Grid>
            </Grid>
          </Box>
          <Button
            variant="contained"
            startIcon={refreshingDID ? <SyncIcon sx={{ animation: 'spin 1s linear infinite', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} /> : <RefreshIcon />}
            onClick={handleRefreshDID}
            disabled={refreshingDID || agentStatus.status === 'running'}
            sx={{ minWidth: 150 }}
          >
            {refreshingDID ? 'Refreshing...' : 'Refresh DIDs'}
          </Button>
        </Box>
        {didRotation.allNumbers && didRotation.allNumbers.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" color="textSecondary">
              Loaded DIDs: {didRotation.allNumbers.join(', ')}
            </Typography>
          </Box>
        )}
      </Paper>

      {/* Add/Edit User Dialog */}
      <UserEditDialog
        open={openDialog}
        editingUser={editingUser}
        formData={formData}
        onClose={handleCloseDialog}
        onInputChange={handleInputChange}
        onSubmit={handleSubmit}
      />

      {/* CSV Import Dialog */}
      <Dialog open={openCSVDialog} onClose={() => setOpenCSVDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Import Users from CSV</DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>
              CSV format: firstname, lastname, phone, address, state
            </Alert>
            <input
              type="file"
              accept=".csv"
              onChange={handleCSVUpload}
              style={{ display: 'none' }}
              id="csv-file-input"
            />
            <label htmlFor="csv-file-input">
              <Button variant="contained" component="span" fullWidth>
                Select CSV File
              </Button>
            </label>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenCSVDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default AgentControl;
