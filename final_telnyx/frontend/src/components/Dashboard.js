import React, { useState, useEffect } from 'react';
import {
  Grid,
  Paper,
  Typography,
  Box,
  Card,
  CardContent,
  Chip,
  List,
  ListItem,
  ListItemText,
  Divider,
  Badge,
} from '@mui/material';
import {
  Phone as PhoneIcon,
  CheckCircle as CheckIcon,
  Cancel as CancelIcon,
  People as PeopleIcon,
  TrendingUp as TrendingUpIcon,
  PhoneInTalk as ActiveCallIcon,
  RecordVoiceOver as VoiceIcon,
  Sync as RotationIcon,
  AccessTime as TimeIcon,
} from '@mui/icons-material';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { agentAPI, usersAPI, didAPI } from '../services/api';

function StatCard({ title, value, icon, color, subtitle }) {
  return (
    <Card sx={{ height: '100%', boxShadow: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box>
            <Typography color="textSecondary" gutterBottom variant="body2">
              {title}
            </Typography>
            <Typography variant="h3" component="div" sx={{ fontWeight: 'bold', color }}>
              {value}
            </Typography>
            {subtitle && (
              <Typography variant="caption" color="textSecondary" sx={{ mt: 1 }}>
                {subtitle}
              </Typography>
            )}
          </Box>
          <Box
            sx={{
              backgroundColor: color,
              borderRadius: '50%',
              width: 64,
              height: 64,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 2,
            }}
          >
            {icon}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

function Dashboard({ wsConnection }) {
  const [stats, setStats] = useState({
    totalCalls: 0,
    successfulCalls: 0,
    qualifiedLeads: 0,
    disqualifiedLeads: 0,
    totalUsers: 0,
    pendingUsers: 0,
    agentStatus: 'stopped',
  });

  const [activeCalls, setActiveCalls] = useState([]);
  const [recentActivity, setRecentActivity] = useState([]);
  const [didRotation, setDidRotation] = useState({ 
    allNumbers: [], 
    currentIndex: 0, 
    numbersByState: {},
    numbersByAreaCode: {},
    strategy: 'area_code'
  });
  const [chartData, setChartData] = useState([]);

  useEffect(() => {
    fetchStats();
    fetchDIDRotation();
    const interval = setInterval(() => {
      fetchStats();
      fetchDIDRotation();
    }, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!wsConnection) return;

    wsConnection.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'call_event') {
        // Add to recent activity
        addActivity({
          event: data.event,
          callControlId: data.callControlId,
          timestamp: data.timestamp,
          details: data.aiResponse || data.transcript || data.hangupCause,
        });
        
        // Update active calls
        if (data.event === 'answered') {
          setActiveCalls(prev => [...prev, {
            id: data.callControlId,
            status: 'active',
            timestamp: data.timestamp,
          }]);
        } else if (data.event === 'hangup') {
          setActiveCalls(prev => prev.filter(call => call.id !== data.callControlId));
        }
        
        // Refresh stats
        fetchStats();
      }
    };
  }, [wsConnection]);

  const addActivity = (activity) => {
    setRecentActivity(prev => [activity, ...prev].slice(0, 20)); // Keep last 20
  };

  const fetchDIDRotation = async () => {
    try {
      const res = await didAPI.getRotation();
      if (res.data.success) {
        setDidRotation(res.data.data);
      }
    } catch (error) {
      console.error('Error fetching DID rotation:', error);
    }
  };

  const fetchStats = async () => {
    try {
      const [agentStatsRes, usersRes] = await Promise.all([
        agentAPI.getStats(),
        usersAPI.getAll(),
      ]);

      const agentStats = agentStatsRes.data.data;
      const users = usersRes.data.data;

      setStats({
        totalCalls: agentStats.totalCalls || 0,
        successfulCalls: agentStats.successfulCalls || 0,
        qualifiedLeads: agentStats.qualifiedLeads || 0,
        disqualifiedLeads: agentStats.disqualifiedLeads || 0,
        totalUsers: users.length,
        pendingUsers: users.filter(u => u.status === 'pending').length,
        agentStatus: agentStats.status || 'stopped',
      });

      // Update chart data
      setChartData([
        { name: 'Successful', value: agentStats.successfulCalls || 0, fill: '#4caf50' },
        { name: 'Failed', value: agentStats.failedCalls || 0, fill: '#f44336' },
        { name: 'Qualified', value: agentStats.qualifiedLeads || 0, fill: '#ff9800' },
        { name: 'Disqualified', value: agentStats.disqualifiedLeads || 0, fill: '#9e9e9e' },
      ]);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'running': return 'success';
      case 'paused': return 'warning';
      case 'stopped': return 'error';
      default: return 'default';
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
          Dashboard
        </Typography>
        <Chip 
          label={`Agent: ${stats.agentStatus.toUpperCase()}`} 
          color={getStatusColor(stats.agentStatus)}
          sx={{ fontSize: '1rem', px: 2, py: 0.5 }}
        />
      </Box>

      <Grid container spacing={3}>
        {/* Stat Cards */}
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Total Calls"
            value={stats.totalCalls}
            icon={<PhoneIcon sx={{ color: 'white', fontSize: 32 }} />}
            color="#1976d2"
            subtitle="All initiated calls"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Qualified Leads"
            value={stats.qualifiedLeads}
            icon={<TrendingUpIcon sx={{ color: 'white', fontSize: 32 }} />}
            color="#4caf50"
            subtitle={`${stats.totalCalls > 0 ? ((stats.qualifiedLeads / stats.totalCalls) * 100).toFixed(1) : 0}% conversion`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Disqualified"
            value={stats.disqualifiedLeads}
            icon={<CancelIcon sx={{ color: 'white', fontSize: 32 }} />}
            color="#f44336"
            subtitle="Did not qualify"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Active Calls"
            value={activeCalls.length}
            icon={<ActiveCallIcon sx={{ color: 'white', fontSize: 32 }} />}
            color="#ff9800"
            subtitle="Currently in progress"
          />
        </Grid>

        {/* System Status */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <VoiceIcon /> Voice AI Configuration
            </Typography>
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">Voice Engine:</Typography>
                <Chip label="Azure Neural HD" size="small" color="primary" />
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">Voice:</Typography>
                <Chip label="Aria (en-US)" size="small" color="secondary" />
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">STT Engine:</Typography>
                <Chip label="Telnyx (A)" size="small" />
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography variant="body2" color="textSecondary">AI Model:</Typography>
                <Chip label="GPT-4 Turbo" size="small" />
              </Box>
            </Box>
          </Paper>
        </Grid>

        {/* DID Rotation Status */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <RotationIcon /> DID Rotation by Area Code/State
            </Typography>
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">Strategy:</Typography>
                <Chip 
                  label={didRotation.strategy === 'area_code' ? 'Area Code Match' : 'Round Robin'} 
                  size="small" 
                  color="primary" 
                />
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">Total DIDs:</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
                  {didRotation.allNumbers?.length || 0}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">States Covered:</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#4caf50' }}>
                  {Object.keys(didRotation.numbersByState || {}).length}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="textSecondary">Area Codes:</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#ff9800' }}>
                  {Object.keys(didRotation.numbersByAreaCode || {}).length}
                </Typography>
              </Box>
              <Divider sx={{ my: 1 }} />
              <Box sx={{ maxHeight: 120, overflow: 'auto' }}>
                <Typography variant="caption" color="textSecondary" sx={{ fontWeight: 'bold' }}>
                  Top States:
                </Typography>
                {Object.entries(didRotation.numbersByState || {})
                  .sort((a, b) => b[1].length - a[1].length)
                  .slice(0, 5)
                  .map(([state, numbers]) => (
                    <Box key={state} sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                      <Typography variant="caption">{state}:</Typography>
                      <Chip label={numbers.length} size="small" sx={{ height: 18, fontSize: '0.7rem' }} />
                    </Box>
                  ))}
              </Box>
            </Box>
          </Paper>
        </Grid>

        {/* Chart */}
        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom>
              Call Statistics
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="value" fill="#1976d2" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        {/* Pie Chart */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom>
              Lead Qualification
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={[
                    { name: 'Qualified', value: stats.qualifiedLeads, fill: '#4caf50' },
                    { name: 'Disqualified', value: stats.disqualifiedLeads, fill: '#f44336' },
                  ]}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  outerRadius={80}
                  dataKey="value"
                />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        {/* Active Calls */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, boxShadow: 3, height: 400, overflow: 'auto' }}>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Badge badgeContent={activeCalls.length} color="primary">
                <ActiveCallIcon />
              </Badge>
              Active Calls
            </Typography>
            <Divider sx={{ mb: 2 }} />
            {activeCalls.length === 0 ? (
              <Typography variant="body2" color="textSecondary" sx={{ textAlign: 'center', mt: 4 }}>
                No active calls
              </Typography>
            ) : (
              <List>
                {activeCalls.map((call, index) => (
                  <ListItem key={call.id} sx={{ bgcolor: '#f5f5f5', mb: 1, borderRadius: 1 }}>
                    <ListItemText
                      primary={`Call ${index + 1}`}
                      secondary={`Started: ${formatTime(call.timestamp)}`}
                    />
                    <Chip label="ACTIVE" size="small" color="success" />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>
        </Grid>

        {/* Recent Activity */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, boxShadow: 3, height: 400, overflow: 'auto' }}>
            <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TimeIcon /> Recent Activity
            </Typography>
            <Divider sx={{ mb: 2 }} />
            {recentActivity.length === 0 ? (
              <Typography variant="body2" color="textSecondary" sx={{ textAlign: 'center', mt: 4 }}>
                No recent activity
              </Typography>
            ) : (
              <List>
                {recentActivity.map((activity, index) => (
                  <React.Fragment key={index}>
                    <ListItem sx={{ px: 0 }}>
                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Chip 
                              label={activity.event} 
                              size="small" 
                              color={
                                activity.event === 'answered' ? 'success' :
                                activity.event === 'hangup' ? 'error' :
                                activity.event === 'transcription' ? 'info' : 'default'
                              }
                            />
                            <Typography variant="caption" color="textSecondary">
                              {formatTime(activity.timestamp)}
                            </Typography>
                          </Box>
                        }
                        secondary={
                          activity.details ? (
                            <Typography variant="body2" sx={{ mt: 0.5, fontStyle: 'italic' }}>
                              {activity.details.substring(0, 80)}...
                            </Typography>
                          ) : null
                        }
                      />
                    </ListItem>
                    {index < recentActivity.length - 1 && <Divider />}
                  </React.Fragment>
                ))}
              </List>
            )}
          </Paper>
        </Grid>

        {/* Performance Metrics */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom>
              📊 Performance Metrics
            </Typography>
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, p: 2, bgcolor: '#e3f2fd', borderRadius: 1 }}>
                <Typography variant="body1">Success Rate</Typography>
                <Typography variant="h6" sx={{ color: '#1976d2', fontWeight: 'bold' }}>
                  {stats.totalCalls > 0
                    ? ((stats.successfulCalls / stats.totalCalls) * 100).toFixed(1)
                    : 0}%
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, p: 2, bgcolor: '#e8f5e9', borderRadius: 1 }}>
                <Typography variant="body1">Qualification Rate</Typography>
                <Typography variant="h6" sx={{ color: '#4caf50', fontWeight: 'bold' }}>
                  {stats.totalCalls > 0
                    ? ((stats.qualifiedLeads / stats.totalCalls) * 100).toFixed(1)
                    : 0}%
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', p: 2, bgcolor: '#fff3e0', borderRadius: 1 }}>
                <Typography variant="body1">Pending Calls</Typography>
                <Typography variant="h6" sx={{ color: '#ff9800', fontWeight: 'bold' }}>
                  {stats.pendingUsers}
                </Typography>
              </Box>
            </Box>
          </Paper>
        </Grid>

        {/* User Statistics */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom>
              👥 User Database
            </Typography>
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, p: 2, bgcolor: '#f3e5f5', borderRadius: 1 }}>
                <Typography variant="body1">Total Users</Typography>
                <Typography variant="h6" sx={{ color: '#9c27b0', fontWeight: 'bold' }}>
                  {stats.totalUsers}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, p: 2, bgcolor: '#e0f2f1', borderRadius: 1 }}>
                <Typography variant="body1">Pending</Typography>
                <Typography variant="h6" sx={{ color: '#009688', fontWeight: 'bold' }}>
                  {stats.pendingUsers}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', p: 2, bgcolor: '#fce4ec', borderRadius: 1 }}>
                <Typography variant="body1">Called</Typography>
                <Typography variant="h6" sx={{ color: '#e91e63', fontWeight: 'bold' }}>
                  {stats.totalUsers - stats.pendingUsers}
                </Typography>
              </Box>
            </Box>
          </Paper>
        </Grid>

        {/* Chart */}
        <Grid item xs={12}>
          <Paper sx={{ p: 3, boxShadow: 3 }}>
            <Typography variant="h6" gutterBottom>
              📈 Call Statistics Overview
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="value" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}

export default Dashboard;

